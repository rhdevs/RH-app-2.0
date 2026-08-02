/**
 * Interview slot invariants — post-migration gate and standing drift census.
 * READ-ONLY.
 *
 *   node scripts/remediation/verify-interview-slots.mjs            # all CCAs
 *   node scripts/remediation/verify-interview-slots.mjs --cca 12   # one CCA
 *
 * TOUCHES THE DATABASE: reads only. No write, no index build, no delete.
 *
 * Group interview slots (docs/plans/cca/01) made occupancy DERIVED — the
 * application's `interviewSlotID` is the only claim, and `capacity` on the slot
 * is the bound. Nothing in Mongo enforces either half: there is no unique index
 * on the pointer and no constraint tying it to a live slot, so over-booking is
 * prevented by the advisory lock alone. This script is what notices when that
 * assumption stops holding.
 *
 * RUN IT after the migration, after any hand-fix, and periodically. Check [1]
 * is the one that matters: an over-capacity slot means a group interview will
 * have more people in the room than the head planned for, and nothing in the UI
 * will say so.
 *
 * EXIT CODES
 *   0  invariants hold. Drift counts printed as warnings.
 *   1  a BLOCKING invariant failed:
 *      [1] a slot holds more applicants than its capacity
 *      [2] a slot carries a capacity below 1 or above the schema max
 *      [3] a LIVE application points at a canceled or non-existent slot
 *      [5] a slot still carries the deleted booked* claim scalars
 *      [7] a rejected/withdrawn application still holds a live future seat
 *   2  could not connect, an unusable --cca argument (non-integer, or one that
 *      matches no data at all), or an unexpected throw.
 */
import { PrismaClient } from "@prisma/client";
import { findAll, numify } from "./lib/rbac.mjs";

const db = new PrismaClient();
let failed = 0;
const fail = (m) => {
  console.error(`  FAIL  ${m}`);
  failed++;
};
const warn = (m) => console.log(`  warn  ${m}`);

/** Mirrors src/lib/schemas/ccaApplication.ts — plain .mjs cannot import it. */
const SLOT_CAPACITY_DEFAULT = 1;
const SLOT_CAPACITY_MAX = 20;
const TERMINAL = new Set(["accepted", "rejected", "withdrawn"]);

/**
 * `interviewed` is NEITHER terminal NOR a live booking — see the long note in
 * backfill-slot-capacity.mjs. Short version: the application is still open
 * (so not terminal), but the interview has already happened and head cancelSlot
 * only reverts `interview_scheduled` — so an interviewed applicant left
 * pointing at a canceled slot is the record of an interview that took place,
 * produced by two ordinary head actions. Check [3] must report it as history,
 * not fail on it.
 */
const HISTORICAL = new Set([...TERMINAL, "interviewed"]);

/** The three fields the migration removes. Checked by $exists, not by value. */
const CLAIM_FIELDS = ["bookedByUserID", "bookedApplicationID", "bookedAt"];

/**
 * `--cca N`, or null for every CCA.
 *
 * A non-integer is REFUSED rather than coerced. `Number("all")` and
 * `Number(undefined)` are both NaN, which is not null, so the scope filter
 * would match zero rows and every check would pass having examined nothing —
 * a verifier printing PASS over an empty set is worse than no verifier.
 */
const onlyCca = (() => {
  const i = process.argv.indexOf("--cca");
  if (i === -1) return null;
  const arg = process.argv[i + 1];
  const n = Number(arg);
  if (arg === undefined || arg.trim?.() === "" || !Number.isInteger(n)) {
    console.error(
      `\n*** --cca needs an integer ccaID; got ${JSON.stringify(arg)}. ` +
        `Refusing to run: a NaN scope silently checks nothing and prints PASS. ***\n`,
    );
    process.exit(2);
  }
  return n;
})();

function intOrNull(v) {
  if (v == null) return null;
  const n = numify(v);
  return Number.isFinite(n) ? n : null;
}
/** Present AND non-null. */
const has = (v) => v !== undefined && v !== null;
/** $exists semantics. The old openSlots wrote the claim fields as EXPLICIT
 *  NULLS, so a non-null test finds 1 of the 31 production rows that carry
 *  them — and check [5] could then never fail on a pre-migration database. */
const present = (d, k) =>
  Object.prototype.hasOwnProperty.call(d, k) && d[k] !== undefined;

/** THE definition of a seat count, mirrored from slotCapacity() in
 *  src/server/api/services/ccaApplications.ts. If these two ever disagree this
 *  script reports invariants the app does not actually hold. */
const slotCapacity = (c) =>
  typeof c === "number" && Number.isFinite(c) && Math.floor(c) >= 1
    ? Math.floor(c)
    : SLOT_CAPACITY_DEFAULT;

async function main() {
  console.log(`\n=== verify-interview-slots.mjs (READ-ONLY) ===\n`);

  // Raw reads, not typed ones: the whole point of checks [2] and [5] is to see
  // fields Prisma no longer models (booked*) and values it would happily
  // deserialize past (a capacity of 0).
  let slots = (await findAll(db, "CcaInterviewSlot")).map((d) => ({
    slotID: intOrNull(d.slotID),
    ccaID: intOrNull(d.ccaID),
    startTime: intOrNull(d.startTime),
    endTime: intOrNull(d.endTime),
    rawCapacity: intOrNull(d.capacity),
    // Non-null, not merely $exists: a stored `capacity: null` is exactly what
    // the migration rewrites, so it belongs with "absent" and not with "set".
    capacityUsable: has(d.capacity),
    canceled: has(d.canceledAt),
    leftovers: CLAIM_FIELDS.some((k) => present(d, k)),
  }));
  let apps = (await findAll(db, "CcaApplication")).map((d) => ({
    applicationID: intOrNull(d.applicationID),
    ccaID: intOrNull(d.ccaID),
    userID: d.userID == null ? null : String(d.userID),
    status: d.status == null ? null : String(d.status),
    interviewSlotID: intOrNull(d.interviewSlotID),
  }));

  if (onlyCca !== null) {
    slots = slots.filter((s) => s.ccaID === onlyCca);
    apps = apps.filter((a) => a.ccaID === onlyCca);
    console.log(`scoped to ccaID ${onlyCca}\n`);
    // A ZERO-ROW SCOPE IS REFUSED, for the same reason a non-integer one is: an
    // integer that matches nothing — `--cca 999`, or `--cca 4` fat-fingered for
    // `--cca 49` — makes every check below pass having examined no data, and
    // PASS over an empty set is worse than no verifier. A CCA with slots but no
    // applications (or the reverse) is legitimate and still runs; only "neither
    // exists" is treated as a mistyped id.
    if (slots.length === 0 && apps.length === 0) {
      console.error(
        `\n*** ccaID ${onlyCca} has no interview slots AND no applications. ` +
          `Refusing to report PASS over an empty set — check the id. ` +
          `Run without --cca to verify every CCA. ***\n`,
      );
      process.exit(2);
    }
  }

  const slotByID = new Map(slots.map((s) => [s.slotID, s]));
  const occupants = new Map();
  for (const a of apps) {
    if (a.interviewSlotID === null) continue;
    const arr = occupants.get(a.interviewSlotID) ?? [];
    arr.push(a);
    occupants.set(a.interviewSlotID, arr);
  }

  console.log(`slots: ${slots.length}   applications: ${apps.length}`);
  console.log(
    `claimed seats: ${[...occupants.values()].reduce((n, v) => n + v.length, 0)}`,
  );
  // Unscoped and empty is a DIFFERENT statement from a mistyped --cca: it means
  // the feature has genuinely never been used. Said out loud rather than left
  // to read as a clean bill of health.
  if (onlyCca === null && slots.length === 0 && apps.length === 0) {
    warn(
      `there are no interview slots and no applications AT ALL. Every check ` +
        `below passes vacuously — this is "nothing exists yet", not "everything ` +
        `is correct".`,
    );
  }

  /* [1] OCCUPANCY <= CAPACITY --------------------------------------------- */
  // The invariant the advisory lock exists to keep. A breach here means either
  // a write got in outside withCcaLock, or a capacity was lowered by hand under
  // people who had already booked.
  console.log(`\n[1] occupancy <= capacity (blocking)`);
  let overCount = 0;
  for (const s of slots) {
    const occ = (occupants.get(s.slotID) ?? []).length;
    const cap = slotCapacity(s.rawCapacity);
    if (occ > cap) {
      overCount++;
      fail(
        `slot #${s.slotID} (ccaID ${s.ccaID}) holds ${occ} applicant(s) but capacity is ${cap}: ` +
          `applications ${(occupants.get(s.slotID) ?? []).map((a) => `#${a.applicationID}`).join(", ")}`,
      );
    }
  }
  console.log(`  over capacity: ${overCount}`);

  /* [2] CAPACITY IS SANE --------------------------------------------------- */
  console.log(`\n[2] capacity within 1..${SLOT_CAPACITY_MAX} (blocking)`);
  let absent = 0;
  let badCap = 0;
  for (const s of slots) {
    if (!s.capacityUsable) {
      absent++;
      continue;
    }
    if (s.rawCapacity === null || s.rawCapacity < 1 || s.rawCapacity > SLOT_CAPACITY_MAX) {
      badCap++;
      fail(`slot #${s.slotID}: capacity ${JSON.stringify(s.rawCapacity)} is outside 1..${SLOT_CAPACITY_MAX}`);
    }
  }
  console.log(`  out of range: ${badCap}`);
  console.log(`  absent or null: ${absent}`);
  if (absent > 0) {
    warn(
      `${absent} slot(s) have no usable capacity (absent or null). slotCapacity() reads them as ` +
        `${SLOT_CAPACITY_DEFAULT}, so nothing is broken — but backfill-slot-capacity.mjs ` +
        `has not been run (or has not been run since these were written).`,
    );
  }

  /* [3] POINTERS RESOLVE --------------------------------------------------- */
  // Blocking only for a LIVE application. A HISTORICAL one (terminal, or
  // `interviewed`) pointing at a canceled or deleted slot is the record of an
  // interview that was scheduled and, in the interviewed case, actually
  // happened — clearing it would erase that. See HISTORICAL above for why
  // `interviewed` belongs here and not with the live statuses.
  console.log(`\n[3] applications point at a live slot (blocking for live apps)`);
  let missing = 0;
  let atCanceled = 0;
  let historical = 0;
  for (const a of apps) {
    if (a.interviewSlotID === null) continue;
    const s = slotByID.get(a.interviewSlotID);
    const isHistorical = HISTORICAL.has(a.status ?? "");
    if (!s) {
      if (isHistorical) historical++;
      else {
        missing++;
        fail(`application #${a.applicationID} (${a.status}) points at slot #${a.interviewSlotID}, which does not exist`);
      }
      continue;
    }
    if (s.canceled) {
      if (isHistorical) historical++;
      else {
        atCanceled++;
        fail(
          `application #${a.applicationID} (${a.status}) points at slot #${s.slotID}, which is CANCELED — ` +
            `this resident thinks they have an interview that is not happening`,
        );
      }
    }
  }
  console.log(`  live -> missing slot:  ${missing}`);
  console.log(`  live -> canceled slot: ${atCanceled}`);
  console.log(`  historical, left alone:${String(historical).padStart(3)}`);
  if (historical > 0) {
    warn(`${historical} decided/withdrawn/interviewed application(s) still name a canceled or deleted slot — kept on purpose, that is the record.`);
  }

  /* [4] STATUS AGREES WITH THE POINTER ------------------------------------- */
  // Not blocking: neither direction breaks a booking, and both are visible in
  // the UI. Reported because a drift here is how a resident ends up unable to
  // book (status says scheduled) or unable to find their interview.
  console.log(`\n[4] interview_scheduled <-> a slot pointer`);
  const scheduledNoSlot = apps.filter(
    (a) => a.status === "interview_scheduled" && a.interviewSlotID === null,
  );
  const slotNotScheduled = apps.filter(
    (a) =>
      a.interviewSlotID !== null &&
      a.status !== "interview_scheduled" &&
      !HISTORICAL.has(a.status ?? ""),
  );
  console.log(`  scheduled with no slot: ${scheduledNoSlot.length}`);
  console.log(`  slot held, not scheduled/interviewed: ${slotNotScheduled.length}`);
  if (scheduledNoSlot.length) {
    warn(`e.g. ${scheduledNoSlot.slice(0, 5).map((a) => `#${a.applicationID}`).join(", ")} — these residents see "Waiting for interview" with nothing booked.`);
  }
  if (slotNotScheduled.length) {
    warn(`e.g. ${slotNotScheduled.slice(0, 5).map((a) => `#${a.applicationID} (${a.status})`).join(", ")} — occupying a seat while not scheduled.`);
  }

  /* [5] THE DELETED CLAIM SCALARS ------------------------------------------ */
  // `prisma db push` removes a field from PRISMA'S VIEW only; the documents keep
  // it until backfill-slot-capacity.mjs $unsets them. A leftover is not read by
  // anything any more, but it is a second, stale answer to "who booked this"
  // sitting next to the real one — exactly the drift pair Option C removed.
  //
  // Detected by $exists, not by value: the old openSlots wrote all three as
  // explicit nulls, so a non-null test would find 1 slot instead of 31 and this
  // check could not fail on a pre-migration database at all.
  console.log(`\n[5] leftover ${CLAIM_FIELDS.join(" / ")} (blocking)`);
  const leftovers = slots.filter((s) => s.leftovers);
  console.log(`  slots still carrying them: ${leftovers.length}`);
  if (leftovers.length) {
    fail(
      `${leftovers.length} slot(s) still carry the deleted claim scalars ` +
        `(e.g. ${leftovers.slice(0, 5).map((s) => `#${s.slotID}`).join(", ")}). ` +
        `Run backfill-slot-capacity.mjs --commit.`,
    );
  }

  /* [6] GROUP SLOT CENSUS --------------------------------------------------- */
  console.log(`\n[6] group slot census`);
  const live = slots.filter((s) => !s.canceled);
  const group = live.filter((s) => slotCapacity(s.rawCapacity) > 1);
  const seats = live.reduce((n, s) => n + slotCapacity(s.rawCapacity), 0);
  const taken = live.reduce((n, s) => n + (occupants.get(s.slotID) ?? []).length, 0);
  console.log(`  live slots:   ${live.length}`);
  console.log(`  group slots:  ${group.length}`);
  console.log(`  seats:        ${seats}`);
  console.log(`  seats taken:  ${taken}`);
  if (group.length > 0) {
    const sizes = [...new Set(group.map((s) => slotCapacity(s.rawCapacity)))].sort((a, b) => a - b);
    console.log(`  capacities in use: ${sizes.join(", ")}`);
  }

  /* [7] STRANDED SEATS ----------------------------------------------------- */
  // `rejected` and `withdrawn` BOTH null the pointer in normal operation
  // (reject does so whenever the slot is still future; withdraw always). So one
  // of those still aimed at a live, future slot is a seat nobody can book and
  // nobody is using — no UI shows it, availableSlots just reports one fewer
  // seat, and clearFreeSlots treats the slot as occupied.
  //
  // The known way to produce it is a reject landing inside the migration's
  // snapshot window (see "THE LIVE-SURFACE WINDOW" in backfill-slot-capacity.mjs
  // — which is why --commit refuses to run while the surface is live). Blocking,
  // because the fix is a one-line hand-edit and the alternative is a seat that
  // stays lost.
  console.log(`\n[7] stranded seats (blocking)`);
  const nowSec = Math.floor(Date.now() / 1000);
  const stranded = apps.filter((a) => {
    if (a.interviewSlotID === null) return false;
    if (a.status !== "rejected" && a.status !== "withdrawn") return false;
    const s = slotByID.get(a.interviewSlotID);
    return !!s && !s.canceled && s.endTime !== null && s.endTime > nowSec;
  });
  console.log(`  ${stranded.length}`);
  for (const a of stranded) {
    fail(
      `application #${a.applicationID} (${a.status}) still holds a seat on live future slot #${a.interviewSlotID}. ` +
        `Nobody can book it and nobody is using it — set interviewSlotID = null on that application.`,
    );
  }

  console.log(`\n=== ${failed === 0 ? "PASS" : `FAIL (${failed} blocking)`} ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(`\nUNEXPECTED: ${e?.stack ?? e}\n`);
    process.exit(2);
  })
  .finally(() => db.$disconnect());
