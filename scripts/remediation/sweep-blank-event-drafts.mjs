/**
 * Deletes EMPTY, ABANDONED event drafts — and nothing else (plan D-33).
 *
 *   set -a && . ./.env >/dev/null 2>&1 && set +a && \
 *     node scripts/remediation/sweep-blank-event-drafts.mjs             # dry run
 *   set -a && . ./.env >/dev/null 2>&1 && set +a && \
 *     node scripts/remediation/sweep-blank-event-drafts.mjs --commit    # apply
 *
 * DRY RUN BY DEFAULT. Without `--commit` (or APPLY=yes) it reads and reports and
 * writes nothing. The `set -a && . ./.env` prefix is not decoration: Prisma no
 * longer auto-loads `.env` for standalone node scripts in this repo, so without
 * it the client starts with no DATABASE_URL and the run dies on connect.
 *
 * DO NOT RUN ANY prisma CLI COMMAND AS PART OF THIS. In particular `prisma db
 * push` — it would DROP User.email_unique_ci, the case-insensitive unique index
 * that is the duplicate-account guard and which is not representable in
 * schema.prisma. This script needs no schema step at all; it only reads
 * documents and deletes documents.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * ---------------------------------------------------------------------------
 *
 * Single-screen authoring allocates an `Event` row (and an eventID) the moment a
 * head opens the composer, because the banner upload path is `event/{eventID}/…`
 * and there is no id to upload under until the row exists. A head who opens the
 * composer and closes the tab therefore leaves a row behind with nothing in it.
 * Over a couple of recruitment cycles the events list fills with those.
 *
 * This removes them. An `Event` row is deleted ONLY if ALL NINE of these hold —
 * every one of them, no exceptions, and no flag relaxes any of them:
 *
 *   1. normalizeStatus(status) === "draft"   — anything else has been acted on
 *   2. title, description, publicDescription, bannerUrl, location are all
 *      null / absent / blank-after-trim      — nothing was typed
 *   3. startTime, endTime, facilityID, capacity are all null / absent
 *                                            — nothing was chosen
 *   4. photoUrls is empty                    — no gallery
 *   5. bookingID is null / absent            — it holds no room
 *   6. EventSignup count for this eventID is 0 — nobody signed up
 *   7. EventQuestion count is 0 AND EventAttendance count is 0
 *                                            — no child rows anywhere
 *   8. no RoleAuditLog row carries this targetEventID
 *                                            — nothing worth recording happened
 *   9. createdAt is older than 30 days       — not a head's work in progress
 *
 * ---------------------------------------------------------------------------
 * WHY A HARD DELETE IS ACCEPTABLE HERE WHEN D-21 FORBIDS ONE IN THE APP
 * ---------------------------------------------------------------------------
 *
 * D-21's argument was about A DELETE PATH OVER A COUNTER-KEYED COLLECTION
 * REACHABLE FROM THE UI — a new destructive primitive with a button on it, whose
 * blast radius is whatever a tired head clicks at 2am. That argument does not
 * transfer to this file. THIS IS THE ONLY PLACE AN `Event` ROW IS EVER REMOVED,
 * AND IT IS NOT REACHABLE FROM THE APPLICATION: no procedure, no route and no
 * button reaches this code. It is a guarded remediation script that REFUSES
 * anything carrying a single byte of content, a single child row, or a single
 * audit row.
 *
 * CONDITION 8 IS WHAT MAKES THE DELETION INVISIBLE TO HISTORY RATHER THAN A HOLE
 * IN IT. RoleAuditLog is append-only and every row states what was true when it
 * was written; a delete here cannot and must not rewrite it. So the rule is
 * inverted instead: a row this script may remove is one that NO audit row has
 * ever named. Nothing in the trail points at it, nothing in the trail is left
 * dangling by its removal, and the log after the sweep asserts exactly what it
 * asserted before. If a single RoleAuditLog row carries the eventID, the event
 * has a history — and an event with a history is never deleted here.
 *
 * ---------------------------------------------------------------------------
 * IT MUST NOT AND DOES NOT TOUCH `Counter`
 * ---------------------------------------------------------------------------
 *
 * There is no write to `Counter` anywhere below, and there must never be one.
 * Resetting `Counter{key:"eventID"}.seq` after a delete would RE-ISSUE an eventID
 * that a blob path (`event/{eventID}/banner`), a bookmark, or an audit row may
 * still name. `nextEventId` only ever increments, and that monotonicity is the
 * single property that keeps `event/{eventID}/banner` unambiguous forever.
 *
 * THERE IS A SECOND ROUTE TO THE SAME DAMAGE, AND THIS SCRIPT GUARDS IT. Read
 * services/events.ts:84 — `nextEventId` LAZILY SEEDS the counter from
 * `max(Event.eventID)` when the `Counter{key:"eventID"}` row is ABSENT. So
 * deleting the highest-numbered event while that row does not yet exist lowers
 * the high-water mark the lazy seed reads, and the next event created re-issues a
 * live id. Not by resetting the counter — by deleting the row the counter is
 * derived from. Under `--commit` this script therefore REFUSES to delete unless
 * the `Counter{key:"eventID"}` row exists AND its seq is >= the highest eventID
 * present. It only READS that row; if it is missing the fix is to let the app
 * allocate one id normally (which creates the row), never to hand-write a
 * counter and never to make this script write one.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CANNOT CHECK
 * ---------------------------------------------------------------------------
 *
 *  - IT CANNOT SEE VERCEL BLOB. A head who uploaded a banner and then removed it
 *    may have left an orphan object under `event/{eventID}/…` with no URL on the
 *    row. Deleting the row does not delete that object and this script never
 *    reports it. Blob cleanup is a separate concern; nothing here depends on it.
 *  - IT CANNOT KNOW INTENT. "Blank for 30 days" is a proxy for "abandoned", not a
 *    proof of it. The 30-day floor is the only defence, and it is deliberately
 *    generous.
 *  - IT CANNOT CHECK COLLECTIONS THAT DO NOT EXIST YET, only that they hold
 *    nothing for this eventID. `EventQuestion` and `EventAttendance` are Parts B
 *    and C of the plan and are NOT in prisma/schema.prisma today, so
 *    `db.eventQuestion` / `db.eventAttendance` are not on the generated client and
 *    naming them would fail at runtime. Condition 7 is honoured anyway, by RAW
 *    probe: an absent collection counts as ZERO (an aggregate over a missing
 *    namespace legitimately yields nothing, and an explicit NamespaceNotFound is
 *    tolerated for these two collections only), while ANY OTHER read failure
 *    marks the row UNREADABLE and SKIPS it. It never deletes on a read it could
 *    not perform. When Parts B and C land and the collections appear, the same
 *    code keeps working with no edit.
 *  - IT CANNOT SEE A ROW BEING EDITED IN ANOTHER TAB RIGHT NOW, beyond what the
 *    re-read below covers. Under `--commit` each row is re-read and re-evaluated
 *    from scratch immediately before its own delete, so the window is one round
 *    trip wide — but it is not zero. Run it when the events list is quiet.
 *
 * ---------------------------------------------------------------------------
 * IMPLEMENTATION NOTES THAT ARE EASY TO GET WRONG
 * ---------------------------------------------------------------------------
 *
 * NORMALIZESTATUS IS RE-IMPLEMENTED LOCALLY, ON PURPOSE. The real one is
 * `normalizeStatus` in src/lib/schemas/event.ts:85 — TypeScript, in the app
 * bundle, not importable from a `.mjs` script run under bare node. The copy below
 * mirrors it EXACTLY: anything not in EVENT_STATUSES — including null, including
 * an absent key, including a typo like "Draft" — normalizes to "draft". That
 * mapping is load-bearing here in a way it is not in the app: it means "draft" is
 * the state a row lands in when nobody has said anything about it, which is
 * precisely the population this sweep is aimed at. If EVENT_STATUSES changes in
 * the app, change the copy below in the same commit.
 *
 * THE READ IS UNFILTERED AND THAT IS DELIBERATE. Two reasons, either of which
 * would silently corrupt the result if ignored:
 *   (a) Condition 1 is not expressible as a filter at all. A qualifying row's
 *       status may be the string "draft", or `null`, or an ABSENT KEY, or any
 *       unrecognised string — normalizeStatus flattens all four to "draft" and no
 *       `where` clause flattens them the same way.
 *   (b) In a Prisma `where`, `{ bookingID: null }` matches a STORED null and NOT
 *       an absent key. Filtering conditions 2/3/5 server-side would therefore
 *       quietly miss exactly the rows written before a field existed — the ones
 *       most likely to be blank. So NOT ONE nullable key is filtered on. Every
 *       row is read and every fine condition is applied in JS, where "absent" and
 *       "null" can be told apart and are both handled explicitly.
 * Being over-strict is the correct failure direction throughout: the worst case
 * of a MISSED delete is one extra blank row in a list; the worst case of a WRONG
 * delete is somebody's lost work.
 *
 * REPLY INSPECTION OVER try/catch. `$runCommandRaw` does NOT throw on failure — a
 * failed command resolves as `{ ok: 0, code, errmsg }` and a failed write as
 * `{ ok: 1, writeErrors: [...] }`. Every command below goes through `runCmd`
 * (which inspects AND catches) and every write through `inspectWriteReply`.
 *
 * `process.exitCode` is set; `process.exit()` is never called, so the client
 * always disconnects cleanly and no output is lost.
 */
import { PrismaClient } from "@prisma/client";
import {
  numify,
  findAll,
  inspectWriteReply,
  isCommit,
  banner,
  abort,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** MUST match EVENT_STATUSES in src/lib/schemas/event.ts:39. See the header. */
const EVENT_STATUSES = [
  "draft",
  "submitted",
  "published",
  "changes_requested",
  "declined",
  "canceled",
];

/** Local mirror of normalizeStatus (src/lib/schemas/event.ts:85). Not importable
 *  from a .mjs script — see the header. Null, absent and anything unrecognised
 *  all become "draft". */
function normalizeStatus(raw) {
  return EVENT_STATUSES.includes(raw ?? "") ? raw : "draft";
}

/** Condition 9. Fixed, and deliberately NOT overridable by a flag: a knob that
 *  lets an operator sweep "everything older than a day" is the whole guard. */
const MIN_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_AGE_MS = MIN_AGE_DAYS * DAY_MS;

/** Condition 2 — must all be null / absent / blank after trim. */
const TEXT_FIELDS = ["title", "description", "publicDescription", "bannerUrl", "location"];
/** Condition 3 — must all be null / absent. */
const CHOICE_FIELDS = ["startTime", "endTime", "facilityID", "capacity"];

/** MongoDB's "that namespace isn't there". Tolerated ONLY for the two Part B/C
 *  collections, and only as a count of zero. */
const NS_NOT_FOUND = 26;

/** The counter `nextEventId` derives from when its row is absent. READ ONLY. */
const COUNTER_KEY = "eventID";

const oid = (s) => ({ $oid: s });

/* -------------------------------------------------------------------------- */
/* Raw command plumbing                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run one raw command and normalise BOTH failure shapes into one value. Same
 * shape as create-auth-allowlist.mjs's runCmd. `ok:false` means the COMMAND
 * failed; per-write failures are a separate axis (inspectWriteReply).
 */
async function runCmd(cmd, label) {
  let reply;
  try {
    reply = await db.$runCommandRaw(cmd);
  } catch (e) {
    const msg = String(e?.message ?? e);
    // Best effort at recovering a numeric code from a thrown driver error. If it
    // cannot be recovered the command is reported as a plain failure — never
    // guessed into a tolerable one, because guessing here would mean reporting
    // "zero rows" over a collection that was simply unreadable.
    const m = /code[^0-9]{0,4}(\d{1,5})/i.exec(msg);
    return { ok: false, code: m ? Number(m[1]) : null, errmsg: msg, reply: null, label };
  }
  return {
    ok: numify(reply?.ok) === 1,
    code: reply?.code === undefined ? null : numify(reply.code),
    errmsg: reply?.errmsg === undefined ? null : String(reply.errmsg),
    reply,
    label,
  };
}

/**
 * Count matching documents via `aggregate` + `$count`, NOT via the `count`
 * command. `count` is deprecated on MongoDB 5.0+ and documented as potentially
 * inaccurate, which is unacceptable as the gate on an irreversible delete —
 * lib/rbac.mjs's countWhere carries the same note and the same reasoning.
 *
 * Returns { ok, n, absent, errmsg }:
 *   ok:true    n is trustworthy
 *   ok:false   the read FAILED — the caller must SKIP the row, never read this
 *              as zero
 *
 * An aggregate over a collection that does not exist returns an empty result set
 * with ok:1, i.e. a genuine zero. `tolerateAbsent` additionally accepts an
 * explicit NamespaceNotFound as zero, for deployments that report it that way.
 * That tolerance is granted ONLY to EventQuestion / EventAttendance.
 */
async function countIn(collection, query, { tolerateAbsent = false } = {}) {
  const r = await runCmd(
    { aggregate: collection, pipeline: [{ $match: query }, { $count: "n" }], cursor: {} },
    `count ${collection}`,
  );
  if (!r.ok) {
    const absent =
      r.code === NS_NOT_FOUND ||
      /ns does not exist|NamespaceNotFound/i.test(String(r.errmsg));
    if (absent && tolerateAbsent) return { ok: true, n: 0, absent: true, errmsg: null };
    return { ok: false, n: null, absent, errmsg: r.errmsg };
  }
  const batch = r.reply?.cursor?.firstBatch ?? [];
  // $count emits NO bucket when nothing matches — an empty batch is a real 0,
  // and the pipeline can never overflow one batch because it returns one row.
  return { ok: true, n: batch.length ? numify(batch[0]?.n) : 0, absent: false, errmsg: null };
}

/* -------------------------------------------------------------------------- */
/* Extended-JSON coercion                                                      */
/* -------------------------------------------------------------------------- */
/* Raw replies are not plain JS values: ints arrive as {$numberInt:"3"}, dates as
 * {$date:"…"} or {$date:{$numberLong:"…"}}, _id as {$oid:"…"}. Every helper below
 * fails toward "this row is NOT deletable" rather than toward a convenient
 * default. */

/** Condition 2. Absent and null are blank; a blank-after-trim string is blank;
 *  ANY other value — a number, an object, a non-empty string — is NOT blank and
 *  blocks the delete. */
const isBlank = (v) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Conditions 3 and 5. STRUCTURAL, not numeric: a junk value that does not parse
 *  as a number is still a value somebody stored, and must block the delete. */
const isAbsentOrNull = (v) => v === undefined || v === null;

/** Condition 4. Absent / null / [] qualify; anything else — including a non-array
 *  value — does not. */
function isEmptyArray(v) {
  if (v === undefined || v === null) return true;
  return Array.isArray(v) && v.length === 0;
}

/** Strict int reader. Returns null when the value is absent, null, or not a
 *  finite number — callers treat null as UNREADABLE, never as 0. */
function intOrNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    for (const k of ["$numberInt", "$numberLong", "$numberDouble"]) {
      if (v[k] != null) {
        const n = Number(v[k]);
        return Number.isFinite(n) ? n : null;
      }
    }
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Millisecond epoch from an Extended-JSON date, or null if unreadable. */
function toMillis(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "object" && v.$date !== undefined) {
    const d = v.$date;
    if (typeof d === "string") {
      const t = Date.parse(d);
      return Number.isFinite(t) ? t : null;
    }
    if (typeof d === "number") return Number.isFinite(d) ? d : null;
    if (typeof d === "object" && d?.$numberLong != null) {
      const n = Number(d.$numberLong);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

const hexId = (row) => String(row?._id?.$oid ?? row?._id ?? "");
const isoDay = (ms) => (ms == null ? "(unreadable)" : new Date(ms).toISOString().slice(0, 10));

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Apply all nine conditions to one raw Event document.
 *
 * Returns { eventID, id, deletable, unreadable, blockers[], notes[] }.
 *   blockers    why it is NOT deletable — one entry per failed condition
 *   notes       why it IS deletable — one entry per satisfied condition
 *   unreadable  a READ failed; the row is skipped and the run exits non-zero
 *
 * Conditions 1-5 and 9 are row-local and cheap. They are evaluated FIRST, and the
 * four child-collection reads (6, 7, 8) are only issued for a row that has
 * already passed all of them — a published event with three hundred signups
 * should not cost four aggregates to reject.
 */
async function evaluate(row, nowMs) {
  const id = hexId(row);
  const eventID = intOrNull(row?.eventID);
  const blockers = [];
  const notes = [];

  if (eventID === null) {
    return {
      eventID: null,
      id,
      deletable: false,
      unreadable: true,
      blockers: [`eventID missing or not a number (_id=${id}) — cannot key any child query`],
      notes,
    };
  }

  // -- 1. status ------------------------------------------------------------
  const rawStatus = row?.status === undefined ? null : row.status;
  const status = normalizeStatus(typeof rawStatus === "string" ? rawStatus : null);
  if (status !== "draft") blockers.push(`c1 status is "${status}" — it has been acted on`);
  else notes.push(`c1 draft (stored: ${JSON.stringify(rawStatus)})`);

  // -- 2. nothing typed -----------------------------------------------------
  const typed = TEXT_FIELDS.filter((f) => !isBlank(row?.[f]));
  if (typed.length) blockers.push(`c2 text present: ${typed.join(", ")}`);
  else notes.push(`c2 no text in any of ${TEXT_FIELDS.join("/")}`);

  // -- 3. nothing chosen ----------------------------------------------------
  const chosen = CHOICE_FIELDS.filter((f) => !isAbsentOrNull(row?.[f]));
  if (chosen.length) blockers.push(`c3 chosen: ${chosen.join(", ")}`);
  else notes.push(`c3 no schedule, facility or capacity`);

  // -- 4. gallery -----------------------------------------------------------
  if (!isEmptyArray(row?.photoUrls)) {
    blockers.push(
      `c4 photoUrls not empty (` +
        `${Array.isArray(row.photoUrls) ? `${row.photoUrls.length} photo(s)` : "non-array value"})`,
    );
  } else notes.push(`c4 no gallery`);

  // -- 5. booking -----------------------------------------------------------
  if (!isAbsentOrNull(row?.bookingID)) {
    blockers.push(`c5 bookingID=${JSON.stringify(row.bookingID)} — it holds a room`);
  } else notes.push(`c5 holds no room`);

  // -- 9. age ---------------------------------------------------------------
  // Checked here with the other row-local conditions. createdAt is nullable in
  // the schema, and an UNREADABLE createdAt is NOT "older than 30 days" — it is
  // unknown, and unknown blocks.
  const createdMs = toMillis(row?.createdAt);
  if (createdMs === null) {
    blockers.push(`c9 createdAt absent or unreadable — age cannot be established`);
  } else {
    const ageDays = Math.floor((nowMs - createdMs) / DAY_MS);
    if (nowMs - createdMs < MIN_AGE_MS) {
      blockers.push(
        `c9 created ${isoDay(createdMs)} (${ageDays}d ago) — younger than ${MIN_AGE_DAYS}d`,
      );
    } else {
      notes.push(`c9 created ${isoDay(createdMs)} (${ageDays}d ago)`);
    }
  }

  if (blockers.length) {
    return { eventID, id, deletable: false, unreadable: false, blockers, notes };
  }

  // -- 6, 7, 8. child rows and the audit trail ------------------------------
  // Only reached by a row that is already blank, unchosen, unbooked and old.
  //
  // NOTE ON THE FILTERS: each matches a CONCRETE eventID, never null, so the
  // "stored null vs absent key" hazard from the header does not arise. A
  // RoleAuditLog row whose targetEventID is null or absent is correctly NOT a
  // match — it is not about this event.
  const probes = [
    { coll: "EventSignup", q: { eventID }, tolerateAbsent: false, cond: "c6" },
    { coll: "EventQuestion", q: { eventID }, tolerateAbsent: true, cond: "c7" },
    { coll: "EventAttendance", q: { eventID }, tolerateAbsent: true, cond: "c7" },
    { coll: "RoleAuditLog", q: { targetEventID: eventID }, tolerateAbsent: false, cond: "c8" },
  ];

  for (const p of probes) {
    const r = await countIn(p.coll, p.q, { tolerateAbsent: p.tolerateAbsent });
    if (!r.ok) {
      // A read that FAILED is not a read that returned zero.
      return {
        eventID,
        id,
        deletable: false,
        unreadable: true,
        blockers: [`${p.cond} could not read ${p.coll}: ${r.errmsg} — SKIPPED, not deleted`],
        notes,
      };
    }
    if (r.n !== 0) blockers.push(`${p.cond} ${p.coll} has ${r.n} row(s) for this event`);
    else {
      notes.push(
        `${p.cond} ${p.coll} 0${r.absent ? " (collection absent — Part B/C not shipped)" : ""}`,
      );
    }
  }

  return { eventID, id, deletable: blockers.length === 0, unreadable: false, blockers, notes };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  banner("sweep-blank-event-drafts.mjs", COMMIT);
  console.log(
    `Deletes an Event row ONLY when all NINE D-33 conditions hold. This is the\n` +
      `only place an Event row is ever removed and it is unreachable from the app.\n` +
      `It never writes to Counter.\n`,
  );

  const nowMs = Date.now();

  // -- [0] population -------------------------------------------------------
  // findAll drains the cursor fully and self-verifies against an independent
  // $count, so a truncated read throws instead of quietly halving the census.
  console.log(`--- [0] population ---`);
  const rows = await findAll(db, "Event");
  console.log(`  Event rows read: ${rows.length}`);
  if (!rows.length) {
    console.log(`  nothing to sweep.`);
    return;
  }

  // -- [1] the Counter high-water guard (READ ONLY) -------------------------
  //
  // See the header. nextEventId lazily seeds Counter{key:"eventID"} from
  // max(Event.eventID) when that row is absent, so deleting the top row while the
  // counter row does not exist would re-issue a live id. Reported always,
  // ENFORCED under --commit.
  console.log(`\n--- [1] Counter{key:"${COUNTER_KEY}"} (read only — never written here) ---`);
  const maxEventID = rows.reduce((m, r) => {
    const n = intOrNull(r?.eventID);
    return n !== null && n > m ? n : m;
  }, 0);
  const cRead = await runCmd(
    { find: "Counter", filter: { key: COUNTER_KEY }, limit: 1, batchSize: 1 },
    "find Counter",
  );
  if (!cRead.ok) return abort(`could not read Counter: ${cRead.errmsg}`);
  const counterRow = cRead.reply?.cursor?.firstBatch?.[0] ?? null;
  const counterSeq = counterRow ? intOrNull(counterRow.seq) : null;
  console.log(`  max Event.eventID:  ${maxEventID}`);
  console.log(
    `  Counter seq:        ` +
      `${counterRow ? counterSeq : "(no row — nextEventId would LAZILY SEED from max Event.eventID)"}`,
  );

  let counterSafe = true;
  if (!counterRow) {
    counterSafe = false;
    console.warn(
      `  ! The counter row does not exist. Deleting an event now can LOWER the\n` +
        `    high-water mark nextEventId seeds from, and the next event created would\n` +
        `    re-use a live eventID. Let the app allocate one event id normally (that\n` +
        `    creates the row), then re-run. Do NOT hand-write a Counter row to get\n` +
        `    past this, and do NOT make this script write one.`,
    );
  } else if (counterSeq === null || counterSeq < maxEventID) {
    counterSafe = false;
    console.warn(
      `  ! Counter seq (${JSON.stringify(counterRow.seq)}) is below max Event.eventID (${maxEventID}).\n` +
        `    The next allocation already collides, independently of this sweep.\n` +
        `    Investigate that first — this script will not paper over it and will not\n` +
        `    fix it, because fixing it means writing Counter.`,
    );
  } else {
    console.log(`  OK — seq >= max eventID, so no delete below can rewind id allocation.`);
  }

  // -- [2] evaluation -------------------------------------------------------
  console.log(`\n--- [2] evaluation (${rows.length} row(s)) ---`);
  const candidates = [];
  const kept = [];
  const unreadable = [];

  for (const row of rows) {
    const v = await evaluate(row, nowMs);
    const label = String(v.eventID ?? "?").padEnd(6);
    if (v.unreadable) {
      unreadable.push(v);
      console.error(`  eventID ${label} SKIP    ${v.blockers.join("; ")}`);
    } else if (v.deletable) {
      candidates.push(v);
      console.log(`  eventID ${label} DELETE  all nine conditions hold:`);
      for (const n of v.notes) console.log(`         - ${n}`);
    } else {
      kept.push(v);
      console.log(`  eventID ${label} KEEP    ${v.blockers.join("; ")}`);
    }
  }

  // -- [3] summary ----------------------------------------------------------
  console.log(`\n--- [3] summary ---`);
  console.log(`  rows examined:             ${rows.length}`);
  console.log(`  ${COMMIT ? "to delete:                " : "WOULD be deleted:         "} ${candidates.length}`);
  console.log(`  kept (a condition failed): ${kept.length}`);
  console.log(`  skipped (a read failed):   ${unreadable.length}`);

  if (kept.length) {
    // Bucket by the FIRST failing condition, so "why did nothing get swept" has
    // a one-line answer.
    const buckets = new Map();
    for (const k of kept) {
      const cond = /^c\d/.exec(k.blockers[0] ?? "")?.[0] ?? "c?";
      buckets.set(cond, (buckets.get(cond) ?? 0) + 1);
    }
    console.log(
      `  kept by first failing condition: ` +
        [...buckets].sort().map(([c, n]) => `${c}=${n}`).join(", "),
    );
  }
  if (unreadable.length) {
    // A read that failed is never a delete. Exit non-zero so a human notices,
    // even though the sweep itself did the safe thing.
    process.exitCode = 1;
  }

  if (!candidates.length) {
    console.log(`\nNothing qualifies. No writes ${COMMIT ? "were made" : "would be made"}.`);
    return;
  }

  if (!COMMIT) {
    console.log(
      `\nDRY RUN — nothing was deleted. Re-run with --commit to delete the ` +
        `${candidates.length} row(s) listed above.`,
    );
    return;
  }

  if (!counterSafe) {
    return abort(
      `refusing to delete while the eventID counter cannot be proved safe (see [1]). ` +
        `No Event row was touched.`,
    );
  }

  // -- [4] delete -----------------------------------------------------------
  //
  // Each row is RE-READ by _id and RE-EVALUATED FROM SCRATCH immediately before
  // its own delete. Between [2] and here a head may have reopened the composer
  // and typed a title; the re-check closes that window to one round trip.
  //
  // The delete `q` names _id AND eventID — the exact document just evaluated,
  // with limit 1. It deliberately carries NO further guard: a server-side
  // "bookingID is null" clause cannot portably express "null OR absent" (the
  // hazard in the header), and the JS evaluation one line above is the real gate.
  console.log(`\n--- [4] deleting ---`);
  let deleted = 0;
  const failed = [];

  for (const c of candidates) {
    const re = await runCmd(
      { find: "Event", filter: { _id: oid(c.id) }, limit: 1, batchSize: 1 },
      `re-read Event ${c.eventID}`,
    );
    if (!re.ok) {
      failed.push(`eventID ${c.eventID}: re-read failed: ${re.errmsg}`);
      continue;
    }
    const fresh = re.reply?.cursor?.firstBatch?.[0] ?? null;
    if (!fresh) {
      console.log(`  eventID ${c.eventID}: already gone — nothing to do`);
      continue;
    }
    const recheck = await evaluate(fresh, Date.now());
    if (!recheck.deletable) {
      failed.push(
        `eventID ${c.eventID}: CHANGED since evaluation — ${recheck.blockers.join("; ")} — NOT deleted`,
      );
      continue;
    }

    const reply = await db.$runCommandRaw({
      delete: "Event",
      deletes: [{ q: { _id: oid(c.id), eventID: c.eventID }, limit: 1 }],
    });
    const r = inspectWriteReply(reply, `Event eventID=${c.eventID}`);
    if (!r.ok || r.writeErrors.length) {
      failed.push(`eventID ${c.eventID}: ${JSON.stringify(r.writeErrors)}`);
      continue;
    }
    if (r.n !== 1) {
      failed.push(`eventID ${c.eventID}: delete matched ${r.n} document(s), expected exactly 1`);
      continue;
    }
    deleted += 1;
    console.log(`  - DELETED eventID ${c.eventID} (_id=${c.id})`);
  }

  // -- [5] verify -----------------------------------------------------------
  console.log(`\n--- [5] verify ---`);
  console.log(`  deleted: ${deleted} of ${candidates.length} candidate(s)`);
  for (const f of failed) console.error(`  ! ${f}`);

  let stillPresent = 0;
  for (const c of candidates) {
    const chk = await runCmd(
      { find: "Event", filter: { eventID: c.eventID }, limit: 1, batchSize: 1 },
      `verify ${c.eventID}`,
    );
    if (!chk.ok) {
      console.error(`  ! could not verify eventID ${c.eventID}: ${chk.errmsg}`);
      process.exitCode = 1;
      continue;
    }
    if ((chk.reply?.cursor?.firstBatch ?? []).length) stillPresent += 1;
  }
  console.log(
    `  candidates still present: ${stillPresent}${failed.length ? " (see the failures above)" : ""}`,
  );

  // The counter must read EXACTLY as it did in [1]. Nothing here writes it; this
  // PROVES that rather than asserting it.
  const cAfter = await runCmd(
    { find: "Counter", filter: { key: COUNTER_KEY }, limit: 1, batchSize: 1 },
    "find Counter after",
  );
  const afterSeq = cAfter.ok ? intOrNull(cAfter.reply?.cursor?.firstBatch?.[0]?.seq) : null;
  console.log(`  Counter{key:"${COUNTER_KEY}"}.seq: ${counterSeq} -> ${afterSeq} (must be unchanged)`);
  if (!cAfter.ok || afterSeq !== counterSeq) {
    return abort(
      `the eventID counter changed during this run. This script never writes Counter, ` +
        `so something else did — stop and find out what before creating another event.`,
    );
  }

  if (failed.length) {
    return abort(`${failed.length} candidate(s) were not deleted. See the failures above.`);
  }
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
