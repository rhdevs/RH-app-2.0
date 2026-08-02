/**
 * Removes a named set of CCAs and everything scoped to them.
 *
 *   node scripts/remediation/remove-ccas.mjs            # dry run
 *   node scripts/remediation/remove-ccas.mjs --commit   # apply
 *
 * The set is the five RHMP sub-committees below, per the owner's instruction.
 *
 * KEYED ON NAME, unlike reconcile-ccas.mjs. That script keyed on ccaID because
 * names were the thing it was changing; here the names are the only handle the
 * request gave and nothing renames anything, so the name is stable for the
 * length of the run. It is still not TRUSTED: a name that matches zero rows, or
 * more than one, aborts the whole run rather than guessing, and the resolved
 * ccaIDs are printed in the dry run so they can be eyeballed before --commit.
 *
 * WHAT GOES, AND WHY THAT LINE.
 * Everything scoped to the CCA goes — memberships (UserCCA and the embedded
 * User.userCCA array), headships, profile, applications, interview slots and
 * notes, events, posts. Leaving any of them is not "safe": an orphaned CcaHead
 * row keeps an ex-head's `cca_head` string alive permanently, because
 * revokeCcaHead drops the string only when remaining === 0 and that count never
 * reaches zero while the row survives (services/cascade.ts, GUARD 2).
 *
 * WHAT STAYS: Bookings and BookingLogs. This is the same call reconcile-ccas.mjs
 * made for the retired CCAs — the booking history is left in place, orphaned but
 * intact. An orphaned booking renders without a CCA name; a deleted one is gone.
 * Only one of those is reversible. deleteCcaCascade() DOES delete bookings by
 * ccaID and is deliberately not used here for exactly that reason.
 *
 * ccaID 0 IS REFUSED. BookingModal hardcodes ccaID 0 on every booking the
 * current UI creates, so anything that reaches bookings by ccaID 0 reaches the
 * whole collection. Nothing here deletes bookings, but the guard stays: a CCA
 * row holding 0 is a data problem to fix, not to delete around.
 *
 * EVERY deleted document is written to scripts/remediation/backups/ BEFORE the
 * first delete, in full, so the removal is reversible by re-insert.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  isCommit,
  abort,
  banner,
  fileStamp,
  countWhere,
  inspectWriteReply,
  numify,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

/** Exact ccaName values. Matched literally — no trimming, no case folding: a row
 *  that differs by so much as a trailing space is a DIFFERENT row and this
 *  script must not decide it meant the same thing. */
const TARGETS = [
  "RHMP Cinematography",
  // Lowercase "relations" is how the row is actually stored (ccaID 59). The
  // request spelled it "Corporate Relations"; the literal match above is on the
  // database's spelling, not the request's, and there is no second candidate.
  "RHMP Corporate relations",
  "RHMP Internal Relations",
  "RHMP Post Production",
  "RHMP Production Managers",
];

/** Collections whose rows are scoped to one CCA and are deleted with it.
 *  Order is dependents-first; the CCA row itself is deleted last, so an
 *  interrupted run leaves a CCA with fewer dependents (harmless, re-runnable)
 *  rather than dependents pointing at a row that no longer exists. */
const DEPENDENTS = [
  "Posts",
  "UserCCA",
  "CcaHead",
  "CcaProfile",
  "CcaApplication",
  "CcaInterviewSlot",
  "CcaInterviewNote",
  "Event",
];

/** Scoped to a CCA but deliberately KEPT. Reported, never touched. */
const KEPT = ["Bookings", "BookingLogs"];

/**
 * Read a collection FULLY for the backup, and refuse a partial read.
 *
 * Same trap as lib/rbac.mjs findAll(): a `find` reply is capped by the server's
 * default batch (101 documents) unless batchSize says otherwise, and a backup
 * that silently holds a prefix of what is about to be deleted is worse than no
 * backup — it reads as complete. Volumes here are small enough for one batch, so
 * a non-zero cursor id is treated as a read failure rather than paged into the
 * replica-set getMore hazard documented in that file.
 */
async function readAll(collection, filter) {
  const res = await db.$runCommandRaw({
    find: collection,
    filter,
    batchSize: 100000,
    singleBatch: true,
  });
  if (numify(res?.ok) !== 1) {
    // A collection that does not exist on this cluster still answers ok:1 with
    // an empty batch, so this really is a failure, not an absence.
    throw new Error(`find on ${collection} failed: ${String(res?.errmsg ?? "(no errmsg)")}`);
  }
  const rows = res?.cursor?.firstBatch ?? [];
  const id = res?.cursor?.id;
  if (id && String(numify(id)) !== "0" && String(id) !== "0") {
    throw new Error(
      `find on ${collection} exceeded one batch (${rows.length} read). Refusing ` +
        `to back up a prefix of the documents this script is about to delete.`,
    );
  }
  const expected = await countWhere(db, collection, filter);
  if (rows.length !== expected) {
    throw new Error(
      `find on ${collection} read ${rows.length} document(s) but $count says ${expected}. ` +
        `Refusing to proceed on a partial backup.`,
    );
  }
  return rows;
}

async function main() {
  banner("remove-ccas.mjs", COMMIT);

  const before = await db.cCA.findMany({ orderBy: { ccaID: "asc" } });
  console.log(`CCAs before: ${before.length}`);

  /* --- resolve names -> ccaIDs, refusing anything ambiguous ---------------- */
  const bad = [];
  const targets = [];
  for (const name of TARGETS) {
    const hits = before.filter((c) => c.ccaName === name);
    if (hits.length === 0) bad.push(`${JSON.stringify(name)}: NOT FOUND`);
    else if (hits.length > 1)
      bad.push(
        `${JSON.stringify(name)}: ${hits.length} rows (ccaIDs ${hits.map((h) => h.ccaID).join(", ")}) — ` +
          `resolve the duplicate first, this script will not pick one`,
      );
    else if (hits[0].ccaID === 0)
      bad.push(`${JSON.stringify(name)}: holds the RESERVED ccaID 0 — see verify-cca-roster.mjs [10]`);
    else targets.push(hits[0]);
  }
  if (bad.length) {
    for (const b of bad) console.error(`  BLOCK  ${b}`);
    return abort(
      "the CCA collection does not match this removal list. Re-read it (verify-cca-roster.mjs) and re-derive the plan.",
    );
  }

  const ids = targets.map((t) => t.ccaID);
  const scope = { ccaID: { $in: ids } };

  /* --- plan ---------------------------------------------------------------- */
  console.log(`\n--- DELETE (${targets.length}) ---`);
  for (const t of targets) {
    console.log(`  - ${String(t.ccaID).padStart(3)}  ${t.ccaName.padEnd(28)} [${t.category}]`);
  }

  console.log(`\n--- dependents removed with them ---`);
  const depCounts = {};
  for (const coll of DEPENDENTS) {
    depCounts[coll] = await countWhere(db, coll, scope);
    console.log(`  ${coll.padEnd(18)} ${String(depCounts[coll]).padStart(5)}`);
  }
  // The embedded Int[] on User — Source A of the roster (services/ccaRoster.ts).
  // It is NOT declared in `model User`, so it is reachable only through raw
  // commands and is invisible to every typed read; left alone it keeps stale
  // memberships for a CCA that no longer exists.
  const embedded = await countWhere(db, "User", { userCCA: { $in: ids } });
  console.log(`  ${"User.userCCA[]".padEnd(18)} ${String(embedded).padStart(5)}  (array elements pulled, User rows untouched otherwise)`);

  console.log(`\n--- KEPT, left orphaned on purpose ---`);
  for (const coll of KEPT) {
    console.log(`  ${coll.padEnd(18)} ${String(await countWhere(db, coll, scope)).padStart(5)}`);
  }

  console.log(`\n  CCAs after: ${before.length - targets.length}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Check the ccaIDs above, then re-run with --commit.\n`);
    return;
  }

  /* --- backup, in full, before the first delete ---------------------------- */
  const snapshot = { at: new Date().toISOString(), targets, collections: {} };
  try {
    for (const coll of DEPENDENTS) snapshot.collections[coll] = await readAll(coll, scope);
    // Only _id and the array are needed to undo a $pull; the rest of a User row
    // (passwordHash, base64 profilePictureUrl) has no business in a backup file.
    snapshot.collections["User.userCCA"] = (
      await readAll("User", { userCCA: { $in: ids } })
    ).map((u) => ({ _id: u._id, email: u.email, userCCA: u.userCCA }));
  } catch (e) {
    return abort(`could not read the documents to back up (${String(e?.message ?? e)}). Nothing was deleted.`);
  }

  const out = path.join(process.cwd(), "scripts", "remediation", "backups", `remove-ccas-${fileStamp()}.json`);
  try {
    writeFileSync(out, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`\nBackup written: ${out}`);
  } catch (e) {
    return abort(`could not write the backup (${String(e?.message ?? e)}). Refusing to proceed without one.`);
  }

  /* --- delete -------------------------------------------------------------- */
  let failures = 0;
  const report = (r) => {
    if (!r.ok || r.writeErrors.length || r.writeConcernError.length) {
      failures++;
      console.error(`  ! ${r.label}: ${JSON.stringify([...r.writeErrors, ...r.writeConcernError]).slice(0, 200)}`);
      return false;
    }
    return true;
  };

  for (const coll of DEPENDENTS) {
    const reply = await db.$runCommandRaw({
      delete: coll,
      deletes: [{ q: scope, limit: 0 }],
    });
    const r = inspectWriteReply(reply, `delete ${coll}`);
    if (report(r)) console.log(`  - ${coll.padEnd(18)} deleted ${r.n}`);
  }

  {
    const reply = await db.$runCommandRaw({
      update: "User",
      updates: [{ q: { userCCA: { $in: ids } }, u: { $pull: { userCCA: { $in: ids } } }, multi: true }],
    });
    const r = inspectWriteReply(reply, "pull User.userCCA");
    if (report(r)) console.log(`  - ${"User.userCCA[]".padEnd(18)} updated ${r.nModified}`);
  }

  // The CCA rows last — see the note on DEPENDENTS.
  {
    const reply = await db.$runCommandRaw({
      delete: "CCA",
      deletes: [{ q: scope, limit: 0 }],
    });
    const r = inspectWriteReply(reply, "delete CCA");
    if (report(r)) console.log(`  - ${"CCA".padEnd(18)} deleted ${r.n}`);
  }

  /* --- verify --------------------------------------------------------------- */
  console.log(`\n=== VERIFY ===`);
  const after = await db.cCA.findMany({ orderBy: { ccaID: "asc" } });
  console.log(`CCAs after: ${after.length}`);
  for (const t of targets) {
    const left = after.some((c) => c.ccaID === t.ccaID);
    console.log(`  ccaID ${String(t.ccaID).padStart(3)} ${t.ccaName.padEnd(28)} ${left ? "STILL PRESENT" : "gone"}`);
    if (left) failures++;
  }
  for (const coll of [...DEPENDENTS]) {
    const n = await countWhere(db, coll, scope);
    console.log(`  ${coll.padEnd(18)} remaining ${n} (must be 0)`);
    if (n) failures++;
  }
  const embeddedLeft = await countWhere(db, "User", { userCCA: { $in: ids } });
  console.log(`  ${"User.userCCA[]".padEnd(18)} remaining ${embeddedLeft} (must be 0)`);
  if (embeddedLeft) failures++;
  for (const coll of KEPT) {
    console.log(`  ${coll.padEnd(18)} orphaned ${await countWhere(db, coll, scope)} (kept on purpose)`);
  }
  console.log(`\nfailures: ${failures}`);
  if (failures) return abort("removal did not complete cleanly — the backup holds every pre-image.");
  console.log(`\nDone.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
