/**
 * Doc 01 Step 4 REMEDIATION. Rewrites the ownership key from the PRE-v2
 * derivation to the anchored canonicalUserID on all four collections.
 *
 * ONLY RUN THIS IF inventory-rbac.mjs REPORTED ORPHANS. If it printed zero,
 * this script has nothing to do and will say so.
 *
 *   node scripts/remediation/rekey-canonical.mjs            # dry run (default)
 *   node scripts/remediation/rekey-canonical.mjs --commit   # apply
 *   APPLY=yes node scripts/remediation/rekey-canonical.mjs  # same thing
 *
 * WHY THIS IS DANGEROUS AND WHAT PROTECTS YOU.
 * Every write here is a $set of the OWNERSHIP key. Getting it wrong does not
 * throw — it silently transfers someone's bookings to another id. Protections:
 *   - dry run by default, full plan printed before any write;
 *   - a JSON backup of every affected document is written BEFORE the first
 *     write, and the run refuses to commit if the backup cannot be written;
 *   - REFUSES to run if the new key would COLLIDE with an id that already owns
 *     rows in that collection. Merging two humans' bookings is worse than
 *     leaving them orphaned, and it is not reversible by re-running;
 *   - REFUSES to run if the new key is "" (a non-NUS address). There is no
 *     correct key for those rows; they need hand review;
 *   - idempotent: a re-run finds nothing under the old key and is a no-op.
 *
 * $runCommandRaw does NOT throw on a per-write failure — every reply is read
 * through inspectWriteReply().
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUserID } from "./lib/identity.mjs";
import {
  findAll, numify, legacyCanonicalUserID, inspectWriteReply,
  isCommit, banner, abort, fileStamp,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

const COLLECTIONS = ["UserMatric", "UserRole", "Bookings", "UserCCA"];

async function keyed(coll, userID) {
  const r = await raw({ find: coll, filter: { userID }, projection: { _id: 1, userID: 1, bookingID: 1 }, batchSize: 1000 });
  return r?.cursor?.firstBatch ?? [];
}

async function main() {
  banner("rekey-canonical.mjs", COMMIT);

  const users = await findAll(db, "User", { _id: 1, email: 1 });
  const moves = [];
  for (const u of users) {
    const oldKey = legacyCanonicalUserID(u.email);
    const newKey = canonicalUserID(u.email);
    if (oldKey === newKey || !oldKey) continue;
    for (const coll of COLLECTIONS) {
      const docs = await keyed(coll, oldKey);
      if (docs.length) moves.push({ coll, oldKey, newKey, email: String(u.email ?? ""), docs });
    }
  }

  if (!moves.length) {
    console.log("Nothing to re-key — zero rows under an old key. (This is the expected");
    console.log("outcome; inventory-rbac.mjs is the authority on whether you need this.)");
    return;
  }

  // --- precondition 1: no empty target key -------------------------------
  const toEmpty = moves.filter((m) => m.newKey === "");
  for (const m of toEmpty) {
    console.error(`  BLOCK  ${m.coll}: ${m.docs.length} row(s) under ${m.oldKey} would re-key to "" ` +
      `(email ${JSON.stringify(m.email)} is not @u.nus.edu)`);
  }
  if (toEmpty.length) {
    return abort(`${toEmpty.length} group(s) have no valid target key. These are the D-7 non-NUS ` +
      `accounts from the census — correct the address, merge the account, or accept the block. ` +
      `There is no key this script could write that would be right.`);
  }

  // --- precondition 2: no collision with an id that already owns rows -----
  const collisions = [];
  for (const m of moves) {
    const existing = await keyed(m.coll, m.newKey);
    if (existing.length) collisions.push({ ...m, existing: existing.length });
  }
  for (const c of collisions) {
    console.error(`  BLOCK  ${c.coll}: ${c.newKey} ALREADY owns ${c.existing} row(s); moving ${c.docs.length} ` +
      `row(s) from ${c.oldKey} would merge two identities' data`);
  }
  if (collisions.length) {
    return abort(`${collisions.length} collision(s). Resolve with merge-accounts.mjs / by hand first — ` +
      `merging bookings is not reversible by re-running this script.`);
  }

  // --- plan --------------------------------------------------------------
  console.log(`--- PLAN (${moves.length} group(s)) ---`);
  let total = 0;
  for (const m of moves) {
    total += m.docs.length;
    console.log(`  ${COMMIT ? "+" : "~"} ${m.coll.padEnd(12)} ${m.oldKey} -> ${m.newKey}   ${m.docs.length} row(s)`);
    if (m.coll === "Bookings") console.log(`      bookingIDs: ${m.docs.map((d) => numify(d.bookingID)).join(", ")}`);
  }
  console.log(`  TOTAL rows to re-key: ${total}`);

  // --- backup BEFORE any write ------------------------------------------
  mkdirSync(join(HERE, "backups"), { recursive: true });
  const backupPath = join(HERE, "backups", `rekey-canonical-${fileStamp()}.json`);
  writeFileSync(backupPath, JSON.stringify({ at: new Date().toISOString(), moves }, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    return;
  }

  // --- apply -------------------------------------------------------------
  console.log(`\n--- APPLYING ---`);
  let moved = 0;
  const writeErrors = [];
  for (const m of moves) {
    const reply = await raw({
      update: m.coll,
      ordered: false,
      updates: [{ q: { userID: m.oldKey }, u: { $set: { userID: m.newKey } }, multi: true }],
    });
    const r = inspectWriteReply(reply, `${m.coll} ${m.oldKey}->${m.newKey}`);
    moved += r.nModified;
    if (r.writeErrors.length) writeErrors.push({ group: r.label, errors: r.writeErrors });
    console.log(`  ${m.coll.padEnd(12)} ${m.oldKey} -> ${m.newKey}   nModified=${r.nModified}`);
  }

  // --- verify: re-read, do not trust the counters ------------------------
  console.log(`\n--- VERIFY ---`);
  const stillOrphaned = [];
  for (const m of moves) {
    const left = await keyed(m.coll, m.oldKey);
    if (left.length) stillOrphaned.push(`${m.coll}: ${left.length} row(s) still under ${m.oldKey}`);
  }
  console.log(`rows moved: ${moved}   writeErrors: ${writeErrors.length}`);
  for (const e of writeErrors) console.error(`  WRITE ERROR  ${e.group}: ${JSON.stringify(e.errors)}`);
  for (const s of stillOrphaned) console.error(`  STILL ORPHANED  ${s}`);
  if (writeErrors.length || stillOrphaned.length) {
    return abort(`re-key INCOMPLETE. Backup is at ${backupPath}. Re-run to resume.`);
  }
  console.log(`All groups re-keyed. Re-run inventory-rbac.mjs — it must print zero orphans.`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
