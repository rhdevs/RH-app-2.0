/**
 * Group interview slots (docs/plans/cca/01), the data half.
 *
 *   node scripts/remediation/backfill-slot-capacity.mjs            # dry run
 *   node scripts/remediation/backfill-slot-capacity.mjs --commit   # apply
 *
 * QUIESCE FIRST. `--commit` REFUSES to run while `cca.applications.enabled` is
 * "on" (--allow-live overrides, loudly). See "THE LIVE-SURFACE WINDOW" below —
 * this is not caution, it is the one failure mode of this migration that is
 * both permanent and invisible. The dry run is unaffected by the switch.
 *
 *   node scripts/remediation/set-cca-flag.mjs applications off --commit
 *   node scripts/remediation/backfill-slot-capacity.mjs --commit
 *   node scripts/remediation/set-cca-flag.mjs applications on  --commit   # <-- DO NOT FORGET
 *
 * WHAT CHANGES. `CcaInterviewSlot` stops carrying the claim. Occupancy becomes
 * DERIVED — `count(CcaApplication where interviewSlotID == slotID)` — so the
 * three claim scalars go and a `capacity` is written in their place:
 *
 *   1. GATE on agreement between the two sides. Refuse to start otherwise.
 *   2. SET capacity: 1 explicitly on every slot that has none.
 *   3. RECONCILE the reject case: null the pointer on a TERMINAL application
 *      that still names a LIVE FUTURE slot which no longer names it back.
 *   4. $unset bookedByUserID / bookedApplicationID / bookedAt.
 *
 * IDEMPOTENT — RUNNING `--commit` TWICE LEAVES THE DATABASE BYTE-IDENTICAL
 * AFTER THE FIRST RUN. This is a correctness requirement, not a nicety, and it
 * is enforced in two places rather than assumed:
 *
 *   (a) THE MIGRATED-STATE DETECTOR. If no slot carries any of the three claim
 *       fields AND every slot has a capacity, the script prints "already
 *       migrated" and returns before writing anything — no backup, no update,
 *       no $unset.
 *   (b) THE PER-SLOT MARKER GUARD. Step 3's classification asks "does this
 *       slot's bookedApplicationID still name this application?" — and step 4
 *       DELETES bookedApplicationID. On a second run every slot would answer
 *       "no", so every terminal application holding a pointer would look like a
 *       reject-orphan and have its pointer wiped. (Production application #2 is
 *       `accepted` with interviewSlotID 2: a naive re-run would silently erase
 *       the record of that interview and print "Done.") So a slot that carries
 *       NO claim field at all can never produce a reject-orphan: the absence of
 *       a claim only MEANS anything while the pre-migration marker is present.
 *
 * "CARRIES A CLAIM FIELD" MEANS $exists, NOT non-null. The old openSlots wrote
 * all three as EXPLICIT NULLS, so 31 of the 34 production slots carry them
 * while only 1 holds a real claim. Reading presence as non-null under-reports
 * step 4 by 30 documents and, worse, would make the marker guard above mistake
 * a pre-migration database for a migrated one.
 *
 * THE LIVE-SURFACE WINDOW, and why quiescing is structural rather than advice.
 * Both collections are snapshotted once at the start. If a head REJECTS an
 * applicant who holds a future slot after that snapshot but before step 4
 * finishes, the resulting reject-orphan is not in this run's plan — and step 4
 * then strips the claim marker off that slot, so the marker guard in (b) makes
 * a RE-RUN classify it `unclassifiable` and leave it alone too. The seat is
 * held by a rejected application permanently: verify-interview-slots.mjs
 * passes, availableSlots reports seatsLeft 0, clearFreeSlots sees the slot as
 * occupied, and no surface anywhere says why. The marker guard is still the
 * right trade — never-erase beats always-release — but it converts a
 * recoverable miss into an unrecoverable one, so the window is closed at the
 * source instead. As a backstop the VERIFY block below names any
 * rejected/withdrawn application left pointing at a live future slot; both of
 * those paths null the pointer in normal operation, so a survivor is exactly
 * this leak and can be released by hand.
 *
 * ORDER MATTERS. The gate and step 3 both read the claim scalars, so they must
 * run before the $unset that destroys them — `bookedApplicationID` is the ONLY
 * record of which applicant the slot last belonged to, and it is exactly what
 * distinguishes "rejected, seat already freed" from "still holds a seat". Once
 * it is gone that distinction is unrecoverable, which is why a failed step 2 or
 * 3 aborts BEFORE step 4 rather than falling through to it.
 *
 * WHY STEP 1 IS A HARD GATE. After this migration the application's pointer is
 * the ONLY source of truth. If a slot and its application already disagree
 * today, deriving occupancy from the pointer does not resolve the disagreement,
 * it silently picks a winner — and the losing side is deleted in step 4. So a
 * single mismatch aborts the whole run: the drift has to be understood and
 * fixed by hand first. Measured 2026-08-02 against production: 0 mismatches.
 *
 * WHY capacity IS WRITTEN AND NOT LEFT ABSENT. Prisma+Mongo's `{ capacity:
 * null }` matches a stored null but NOT an absent field, so a filter on it
 * would silently skip every legacy row. slotCapacity() normalises absent/null
 * to 1 in the app so nothing BREAKS if this step is skipped — but "the code
 * rescues it" is not a reason to leave a whole collection in the shape that
 * needs rescuing. Same rule as canceledAt (§0.4 of the plan).
 *
 * $runCommandRaw does NOT throw on a per-write failure — every reply is read
 * through inspectWriteReply, and a non-empty writeErrors stops the run.
 *
 * REVERSIBLE. The backup holds every pre-image, and the three scalars are
 * re-derivable from the application pointers in any case.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  abort,
  banner,
  fileStamp,
  findAll,
  inspectWriteReply,
  isCommit,
  numify,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();
/** Override for the quiesce gate. Deliberately spelled out rather than a bare
 *  --force: the operator should have to type what they are allowing. */
const ALLOW_LIVE = process.argv.includes("--allow-live");
const raw = (cmd) => db.$runCommandRaw(cmd);

/** The kill switch that gates the whole applications surface
 *  (services/ccaApplications.ts). "on" means residents are booking right now. */
const APPLICATIONS_FLAG_KEY = "cca.applications.enabled";

/** Same read as set-cca-flag.mjs — an absent row means "off" (default-closed). */
async function readApplicationsFlag() {
  const r = await raw({
    find: "SystemFlag",
    filter: { key: APPLICATIONS_FLAG_KEY },
    limit: 1,
  });
  return r?.cursor?.firstBatch?.[0]?.value ?? null;
}

/** Mirrors src/lib/schemas/ccaApplication.ts. Kept as literals, not imported:
 *  this file is plain .mjs and the schema module is TypeScript. */
const SLOT_CAPACITY_DEFAULT = 1;
const SLOT_CAPACITY_MAX = 20;

/** Mirrors TERMINAL_STATUSES in the same module. */
const TERMINAL = new Set(["accepted", "rejected", "withdrawn"]);

/**
 * `interviewed` is NEITHER terminal NOR a live booking, and both scripts need
 * that third category.
 *
 * It is not terminal: the application is still open awaiting accept/reject, so
 * isTerminalStatus() returns false and it still blocks a duplicate apply. It is
 * not a live claim either: the interview has HAPPENED, and the head's
 * cancelSlot deliberately reverts only `interview_scheduled` — so marking
 * someone interviewed and then cancelling their slot leaves them pointing at a
 * canceled slot, from two ordinary head actions and no bug. Treating that as
 * drift would abort this migration on data the app legitimately produces;
 * treating it as a reject-orphan would erase the record of an interview that
 * took place. So: HISTORICAL. Counted, left exactly where it is, never
 * released.
 */
const HISTORICAL = new Set([...TERMINAL, "interviewed"]);

/** The three fields step 4 removes. Their PRESENCE is the pre-migration marker. */
const CLAIM_FIELDS = ["bookedByUserID", "bookedApplicationID", "bookedAt"];

/** Extended-JSON int or absent -> a JS number or null. Never 0-for-absent:
 *  a slotID of 0 and "no slot" must not collapse into the same value. */
function intOrNull(v) {
  if (v == null) return null;
  const n = numify(v);
  return Number.isFinite(n) ? n : null;
}

/** $exists semantics. An explicit null IS present — see the header. */
const present = (d, k) =>
  Object.prototype.hasOwnProperty.call(d, k) && d[k] !== undefined;
/** Present AND non-null: an actual value. */
const has = (v) => v !== undefined && v !== null;

async function main() {
  banner("backfill-slot-capacity.mjs", COMMIT);

  /* --- THE QUIESCE GATE --------------------------------------------------- */
  // Read (and print) the switch on every run, so a dry run tells the operator
  // what they will have to do before committing. Enforced only under --commit:
  // reading is harmless with residents booking, writing is not.
  const flag = await readApplicationsFlag();
  const live = flag === "on";
  console.log(
    `${APPLICATIONS_FLAG_KEY}: ${JSON.stringify(flag)}${live ? "  <- LIVE" : "  (surface inert)"}\n`,
  );

  if (COMMIT && live && !ALLOW_LIVE) {
    console.error(
      `The applications surface is LIVE. Residents can book and heads can reject\n` +
        `while this migration runs, and one specific interleaving is unrecoverable:\n` +
        `a reject landing after the snapshot leaves a seat held by a rejected\n` +
        `application FOREVER, with the verifier passing and nothing surfacing it.\n` +
        `(Full explanation: "THE LIVE-SURFACE WINDOW" in this file's header.)\n\n` +
        `Quiesce, migrate, un-quiesce:\n` +
        `  node scripts/remediation/set-cca-flag.mjs applications off --commit\n` +
        `  node scripts/remediation/backfill-slot-capacity.mjs --commit\n` +
        `  node scripts/remediation/set-cca-flag.mjs applications on  --commit   <-- DO NOT FORGET\n\n` +
        `The last line is the one that gets missed. The surface is default-closed,\n` +
        `so forgetting it leaves every resident locked out of /ccas silently.\n\n` +
        `If the owner accepts the risk, re-run with --allow-live.`,
    );
    return abort(`refusing to write while ${APPLICATIONS_FLAG_KEY} is "on".`);
  }
  if (COMMIT && live && ALLOW_LIVE) {
    console.log(
      `*** --allow-live: WRITING AGAINST A LIVE APPLICATIONS SURFACE ***\n` +
        `    Risk accepted: a head rejecting an applicant who holds a future slot,\n` +
        `    between the snapshot below and the end of step 4, permanently strands\n` +
        `    that seat. It cannot be detected by re-running this script and cannot\n` +
        `    be fixed by it either — the marker it would need is gone.\n` +
        `    The VERIFY block at the end names any rejected/withdrawn application\n` +
        `    still pointing at a live future slot; that list IS the leak. Check it,\n` +
        `    and cross-check AuditLog for ccaApplication.reject rows written during\n` +
        `    this run.\n`,
    );
  }

  const slotDocs = await findAll(db, "CcaInterviewSlot");
  const appDocs = await findAll(db, "CcaApplication");
  const nowSec = Math.floor(Date.now() / 1000);

  const slots = slotDocs.map((d) => ({
    slotID: intOrNull(d.slotID),
    ccaID: intOrNull(d.ccaID),
    endTime: intOrNull(d.endTime),
    capacity: intOrNull(d.capacity),
    capacityUsable: has(d.capacity),
    canceled: has(d.canceledAt),
    bookedByUserID: has(d.bookedByUserID) ? String(d.bookedByUserID) : null,
    bookedApplicationID: intOrNull(d.bookedApplicationID),
    // THE PRE-MIGRATION MARKER. $exists on any of the three, so a row written
    // with explicit nulls counts. Everything that reads "the slot does not name
    // this application" is gated on this being true.
    claimMarker: CLAIM_FIELDS.some((k) => present(d, k)),
  }));
  const apps = appDocs.map((d) => ({
    applicationID: intOrNull(d.applicationID),
    ccaID: intOrNull(d.ccaID),
    status: d.status == null ? null : String(d.status),
    interviewSlotID: intOrNull(d.interviewSlotID),
  }));

  const slotByID = new Map(slots.map((s) => [s.slotID, s]));
  const appByID = new Map(apps.map((a) => [a.applicationID, a]));

  const marked = slots.filter((s) => s.claimMarker);
  const needCapacity = slots.filter((s) => !s.capacityUsable);

  console.log(`CcaInterviewSlot: ${slots.length}`);
  console.log(`  canceled:                ${slots.filter((s) => s.canceled).length}`);
  console.log(`  carrying claim FIELDS:   ${marked.length}   <- what step 4 will touch`);
  console.log(`  holding a real claim:    ${slots.filter((s) => s.bookedByUserID !== null || s.bookedApplicationID !== null).length}`);
  console.log(`  with a usable capacity:  ${slots.length - needCapacity.length}`);
  console.log(`CcaApplication:   ${apps.length}`);
  console.log(`  with a slot pointer:     ${apps.filter((a) => a.interviewSlotID !== null).length}`);
  const byStatus = new Map();
  for (const a of apps) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  console.log(`  statuses:                ${JSON.stringify(Object.fromEntries(byStatus))}`);

  /* --- [0] ALREADY MIGRATED? --------------------------------------------- */
  // The idempotence guarantee, enforced rather than assumed. Nothing below this
  // point runs — in particular no backup is written and no update is issued —
  // so a second --commit is a genuine no-op, not a no-op-shaped set of writes.
  if (marked.length === 0 && needCapacity.length === 0) {
    console.log(
      `\nALREADY MIGRATED — every slot has a capacity and none carries ` +
        `${CLAIM_FIELDS.join("/")}. Nothing to do.`,
    );
    console.log(`Run verify-interview-slots.mjs to confirm the invariants hold.\n`);
    return;
  }
  if (marked.length === 0) {
    console.log(
      `\nNOTE: no slot carries the claim fields, so step 4 has already run — but ` +
        `${needCapacity.length} slot(s) still have no capacity. This run does STEP 2 ONLY.`,
    );
    console.log(
      `      Step 3 is IMPOSSIBLE in this state and is skipped: it classifies a ` +
        `pointer by asking whether the slot still names it, and the field that ` +
        `answers that is already gone. Skipping is the safe direction — it can ` +
        `only leave a pointer in place, never erase one.`,
    );
  } else if (marked.length < slots.length) {
    console.log(
      `\nNOTE: ${slots.length - marked.length} slot(s) carry NO claim field while ` +
        `${marked.length} still do — rows predating the explicit-null writes, a ` +
        `hand-created slot, or a partially applied earlier run. They are excluded ` +
        `from steps 1 and 3 (see the header's marker guard); nothing about them ` +
        `is assumed either way.`,
    );
  }

  /* --- [1] THE GATE ------------------------------------------------------ */
  // Both directions. A claim that names an application which does not point
  // back, or a LIVE application pointing at a slot that does not name it, means
  // the two sources of truth have already diverged.
  console.log(`\n--- [1] slot <-> application agreement (blocking) ---`);
  const drift = [];

  for (const s of slots) {
    if (s.bookedByUserID === null && s.bookedApplicationID === null) continue;
    if (s.bookedApplicationID === null) {
      drift.push(
        `slot #${s.slotID}: bookedByUserID=${JSON.stringify(s.bookedByUserID)} but NO bookedApplicationID — cannot tell whose seat this is`,
      );
      continue;
    }
    const a = appByID.get(s.bookedApplicationID);
    if (!a) {
      drift.push(`slot #${s.slotID}: bookedApplicationID ${s.bookedApplicationID} matches no application`);
    } else if (a.interviewSlotID !== s.slotID) {
      drift.push(
        `slot #${s.slotID}: claimed by application #${a.applicationID}, but that application points at ${a.interviewSlotID === null ? "NOTHING" : `#${a.interviewSlotID}`}`,
      );
    }
  }

  // The reverse. Only meaningful on a slot that still carries the marker: on a
  // slot whose claim fields are gone, "does not name this application" is not
  // information, it is this migration's own footprint.
  const rejectOrphans = [];
  let unclassifiable = 0;
  let historical = 0;
  for (const a of apps) {
    if (a.interviewSlotID === null) continue;
    const s = slotByID.get(a.interviewSlotID);
    const isHistorical = HISTORICAL.has(a.status ?? "");
    if (!s) {
      if (isHistorical) {
        console.log(`  warn  application #${a.applicationID} (${a.status}) points at slot #${a.interviewSlotID}, which does not exist — left alone, it can occupy nothing`);
        historical++;
      } else {
        drift.push(`application #${a.applicationID} (${a.status}) points at slot #${a.interviewSlotID}, which does not exist`);
      }
      continue;
    }
    if (!s.claimMarker) {
      unclassifiable++;
      continue;
    }
    if (s.bookedApplicationID === a.applicationID) continue; // the two agree

    // The slot does not name this application, and the marker says we can trust
    // that reading.
    if (!isHistorical) {
      drift.push(
        `application #${a.applicationID} (${a.status}) points at slot #${s.slotID}, which is claimed by ${s.bookedApplicationID === null ? "NOBODY" : `#${s.bookedApplicationID}`}`,
      );
      continue;
    }
    // A pointer only needs releasing if the seat it holds is one somebody else
    // could otherwise use: a LIVE, FUTURE slot. On a canceled or past slot the
    // pointer is the historical record of an interview that was scheduled, and
    // erasing it would lose that — this is the same "iff the slot is still
    // future" rule today's reject already applies, moved onto the pointer.
    // `interviewed` is never released at all (see HISTORICAL above).
    const releasable =
      TERMINAL.has(a.status ?? "") &&
      !s.canceled &&
      s.endTime !== null &&
      s.endTime > nowSec;
    if (releasable) rejectOrphans.push({ ...a, slot: s });
    else historical++;
  }

  if (drift.length) {
    for (const d of drift) console.error(`  BLOCK  ${d}`);
    return abort(
      `${drift.length} slot/application disagreement(s). After this migration the ` +
        `application pointer is the ONLY claim, so running now would pick a winner ` +
        `silently and then delete the loser. Resolve each by hand first.`,
    );
  }
  console.log(`  0 disagreement(s) — the two sides agree.`);
  console.log(`  historical pointers left alone: ${historical}`);
  if (unclassifiable > 0) {
    console.log(
      `  warn  ${unclassifiable} pointer(s) sit on slots with no claim field — ` +
        `not classified, not touched (see the header's marker guard).`,
    );
  }

  /* --- [2] capacity ------------------------------------------------------ */
  const badCapacity = slots.filter(
    (s) =>
      s.capacityUsable &&
      (s.capacity === null || s.capacity < 1 || s.capacity > SLOT_CAPACITY_MAX),
  );
  console.log(`\n--- [2] capacity: ${SLOT_CAPACITY_DEFAULT} on slots that have none ---`);
  console.log(`  to write: ${needCapacity.length}`);
  if (badCapacity.length) {
    for (const s of badCapacity) {
      console.error(`  BLOCK  slot #${s.slotID}: capacity ${JSON.stringify(s.capacity)} is outside 1..${SLOT_CAPACITY_MAX}`);
    }
    return abort(
      `a slot carries a capacity no UI can produce. Someone hand-edited it; ` +
        `fix or remove the value before this script normalises around it.`,
    );
  }

  /* --- [3] the reject case ------------------------------------------------ */
  console.log(`\n--- [3] terminal applications holding a live future seat their slot no longer grants ---`);
  console.log(`  to release: ${rejectOrphans.length}`);
  for (const a of rejectOrphans) {
    console.log(`    application #${a.applicationID} (${a.status}) -> release slot #${a.interviewSlotID}`);
  }
  if (rejectOrphans.length === 0) {
    console.log(`    (none — no rejected applicant is holding a future seat)`);
  }

  /* --- [4] the $unset ----------------------------------------------------- */
  console.log(`\n--- [4] $unset ${CLAIM_FIELDS.join(" / ")} ---`);
  console.log(
    `  slots carrying at least one, by $exists — the same predicate the statement uses: ${marked.length}`,
  );

  /* --- projected occupancy ------------------------------------------------ */
  // What the app will compute the moment the new code is deployed. Printed in
  // the dry run because it is the only chance to see it BEFORE it is live.
  const released = new Set(rejectOrphans.map((a) => a.applicationID));
  const occAfter = new Map();
  for (const a of apps) {
    if (a.interviewSlotID === null || released.has(a.applicationID)) continue;
    occAfter.set(a.interviewSlotID, (occAfter.get(a.interviewSlotID) ?? 0) + 1);
  }
  const over = [];
  const overCanceled = [];
  for (const s of slots) {
    const occ = occAfter.get(s.slotID) ?? 0;
    const cap = s.capacityUsable && s.capacity !== null ? s.capacity : SLOT_CAPACITY_DEFAULT;
    if (occ <= cap) continue;
    const line = `slot #${s.slotID}: ${occ} occupant(s) but capacity ${cap}`;
    // A canceled slot's occupancy is inert — it can never be booked again — so
    // it is reported, not refused.
    if (s.canceled) overCanceled.push(line);
    else over.push(line);
  }
  console.log(`\n--- projected occupancy after this migration ---`);
  console.log(`  slots with someone on them: ${[...occAfter.keys()].filter((k) => slotByID.has(k)).length}`);
  console.log(`  seats claimed:              ${[...occAfter.entries()].filter(([k]) => slotByID.has(k)).reduce((n, [, v]) => n + v, 0)}`);
  for (const o of overCanceled) console.log(`  warn  ${o} (canceled — inert)`);
  if (over.length) {
    for (const o of over) console.error(`  BLOCK  ${o}`);
    return abort(
      `a live slot would come out OVER capacity — two applications already point ` +
        `at a single-seat slot. That cannot happen through the UI, so it is a ` +
        `hand-edit or a restore artefact. Fix it before migrating.`,
    );
  }
  console.log(`  no live slot exceeds its capacity — good.`);

  /* --- index report ------------------------------------------------------- */
  // `prisma db push` DROPS indexes it does not know about (it has taken
  // email_unique_ci out before). Printed here so the operator has a before
  // picture to diff against after the push.
  for (const coll of ["CcaInterviewSlot", "CcaApplication"]) {
    try {
      const idx = await raw({ listIndexes: coll });
      const names = (idx?.cursor?.firstBatch ?? []).map((i) => i.name);
      console.log(`  indexes on ${coll}: ${names.join(", ") || "(none)"}`);
    } catch (e) {
      console.log(`  indexes on ${coll}: unavailable (${String(e?.message ?? e)})`);
    }
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.\n`);
    return;
  }

  /* --- backup, BEFORE the first write ------------------------------------ */
  const out = path.join(
    process.cwd(),
    "scripts",
    "remediation",
    "backups",
    `backfill-slot-capacity-${fileStamp()}.json`,
  );
  try {
    writeFileSync(
      out,
      JSON.stringify(
        { at: new Date().toISOString(), slots: slotDocs, applications: appDocs },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`\nBackup written: ${out}`);
  } catch (e) {
    return abort(
      `could not write the backup (${String(e?.message ?? e)}). Step 4 is a $unset ` +
        `of the only copy of the claim data — refusing to proceed without a pre-image.`,
    );
  }

  console.log(`\n--- APPLYING ---`);
  /**
   * Run one statement, print it, and RETURN whether it was clean. The caller
   * must branch on that: $runCommandRaw resolves on a per-write failure, so a
   * `failures` counter that is only read at the end lets a broken step 2 or 3
   * fall straight through into the irreversible $unset.
   *
   * A writeConcernError COUNTS AS FAILURE. inspectWriteReply returns it as its
   * own field and never folds it into writeErrors (lib/rbac.mjs), so testing
   * writeErrors alone accepts a write that applied on the primary but was not
   * majority-acknowledged — i.e. one an Atlas failover may roll back. Proceeding
   * from there into the $unset would destroy the claim scalars on the strength
   * of a capacity write that then vanished. This is the last path from a failed
   * write into step 4.
   */
  const step = async (label, cmd) => {
    const r = inspectWriteReply(await raw(cmd), label);
    console.log(
      `  ${label.padEnd(34)} n=${r.n} nModified=${r.nModified} writeErrors=${r.writeErrors.length} writeConcernErrors=${r.writeConcernError.length}`,
    );
    if (r.writeErrors.length) {
      console.error(`    writeErrors: ${JSON.stringify(r.writeErrors).slice(0, 400)}`);
    }
    if (r.writeConcernError.length) {
      console.error(
        `    writeConcernError: ${JSON.stringify(r.writeConcernError).slice(0, 400)}`,
      );
    }
    return r.writeErrors.length === 0 && r.writeConcernError.length === 0;
  };
  const stoppedBeforeUnset = (which) =>
    abort(
      `${which} did not complete cleanly (write errors, or a write concern that ` +
        `was not acknowledged). STOPPING BEFORE step 4 — the claim scalars are ` +
        `untouched, so the database is still classifiable and this script can ` +
        `simply be re-run once the cause is fixed. Backup: ${out}`,
    );

  // [2] capacity. Matched on $exists/null rather than by id list so a slot
  // opened between the read above and this write is covered too — and NOT
  // matched on "every slot", so a capacity a head has already set is untouched.
  if (
    !(await step("capacity := 1", {
      update: "CcaInterviewSlot",
      ordered: false,
      updates: [
        {
          q: { $or: [{ capacity: { $exists: false } }, { capacity: null }] },
          u: { $set: { capacity: SLOT_CAPACITY_DEFAULT } },
          multi: true,
        },
      ],
    }))
  ) {
    return stoppedBeforeUnset("step 2 (capacity)");
  }

  // [3] the reject case, one statement per application: each is a different
  // document and the filter has to name it exactly.
  if (rejectOrphans.length > 0) {
    if (
      !(await step("release terminal pointers", {
        update: "CcaApplication",
        ordered: false,
        updates: rejectOrphans.map((a) => ({
          q: { applicationID: a.applicationID, interviewSlotID: a.interviewSlotID },
          u: { $set: { interviewSlotID: null } },
          multi: false,
        })),
      }))
    ) {
      return stoppedBeforeUnset("step 3 (release terminal pointers)");
    }
  }

  // [4] the claim scalars. LAST — steps 1 and 3 read them, and nothing after
  // this point can tell a released seat from a never-claimed one.
  const unsetOk = await step("$unset booked* scalars", {
    update: "CcaInterviewSlot",
    ordered: false,
    updates: [
      {
        q: { $or: CLAIM_FIELDS.map((k) => ({ [k]: { $exists: true } })) },
        u: { $unset: Object.fromEntries(CLAIM_FIELDS.map((k) => [k, ""])) },
        multi: true,
      },
    ],
  });

  /* --- verify ------------------------------------------------------------- */
  console.log(`\n=== VERIFY ===`);
  const slotsAfter = (await findAll(db, "CcaInterviewSlot")).map((d) => ({
    slotID: intOrNull(d.slotID),
    capacity: intOrNull(d.capacity),
    endTime: intOrNull(d.endTime),
    canceled: has(d.canceledAt),
    leftovers: CLAIM_FIELDS.some((k) => present(d, k)),
  }));
  const appsAfter = (await findAll(db, "CcaApplication")).map((d) => ({
    applicationID: intOrNull(d.applicationID),
    status: d.status == null ? null : String(d.status),
    interviewSlotID: intOrNull(d.interviewSlotID),
  }));

  const occ = new Map();
  for (const a of appsAfter) {
    if (a.interviewSlotID === null) continue;
    occ.set(a.interviewSlotID, (occ.get(a.interviewSlotID) ?? 0) + 1);
  }

  const noCapacity = slotsAfter.filter((s) => s.capacity === null || s.capacity < 1);
  const leftovers = slotsAfter.filter((s) => s.leftovers);
  const overAfter = slotsAfter.filter(
    (s) => (occ.get(s.slotID) ?? 0) > (s.capacity ?? SLOT_CAPACITY_DEFAULT),
  );

  // The claim count before must equal the seat count after, on exactly the
  // slots that were claimed. This is the check that would catch a $unset that
  // ran before the gate, or a step-3 filter that released too much.
  const claimedBefore = slots
    .filter((s) => s.bookedApplicationID !== null)
    .map((s) => s.slotID);
  const seatsOnThose = claimedBefore.reduce((n, id) => n + (occ.get(id) ?? 0), 0);

  // THE LIVE-WINDOW BACKSTOP. In normal operation `rejected` and `withdrawn`
  // both null the pointer, so one still aimed at a live FUTURE slot after this
  // run is a stranded seat — almost certainly a reject that landed inside the
  // window (see the header). Reported by name because the marker that would let
  // this script fix it is gone by now; releasing them is a one-line hand-fix.
  const slotAfterByID = new Map(slotsAfter.map((s) => [s.slotID, s]));
  const strandedNow = Math.floor(Date.now() / 1000);
  const stranded = appsAfter.filter((a) => {
    if (a.interviewSlotID === null) return false;
    if (a.status !== "rejected" && a.status !== "withdrawn") return false;
    const s = slotAfterByID.get(a.interviewSlotID);
    return !!s && !s.canceled && s.endTime !== null && s.endTime > strandedNow;
  });

  console.log(`slots:                     ${slotsAfter.length}`);
  console.log(`without a usable capacity: ${noCapacity.length} (must be 0)`);
  console.log(`still carrying booked*:    ${leftovers.length} (must be 0)`);
  console.log(`over capacity:             ${overAfter.length} (must be 0)`);
  console.log(`claimed before:            ${claimedBefore.length}`);
  console.log(`seats on those slots now:  ${seatsOnThose} (must equal claimed-before)`);
  console.log(`stranded seats:            ${stranded.length} (must be 0)`);
  for (const a of stranded) {
    console.error(
      `  STRANDED  application #${a.applicationID} (${a.status}) still holds a seat on live future slot #${a.interviewSlotID}. ` +
        `Release it by hand: set interviewSlotID = null on that application.`,
    );
  }
  if (
    !unsetOk ||
    noCapacity.length ||
    leftovers.length ||
    overAfter.length ||
    stranded.length ||
    seatsOnThose !== claimedBefore.length
  ) {
    return abort(
      `migration did not complete cleanly — the backup holds every pre-image ` +
        `(${out}). Do NOT deploy the new code against this state.`,
    );
  }

  console.log(`\nDone. A re-run of this script will now report "already migrated".`);
  console.log(`Next: prisma db push, then re-check the index list printed above.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
