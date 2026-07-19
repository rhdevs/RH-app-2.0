/**
 * Deletes the test/junk User rows that were created directly in production,
 * and the rows that hang off them.
 *
 *   node scripts/remediation/purge-test-accounts.mjs            # dry run
 *   node scripts/remediation/purge-test-accounts.mjs --commit   # apply
 *
 * WHY AN EXPLICIT _id LIST AND NOT A PATTERN.
 * A regex over emails is how a real person gets deleted. Every id below was
 * read out of the census, eyeballed, and its dependent-row counts checked by
 * hand. The script REFUSES to touch anything not on this list, and refuses to
 * proceed if a listed row's email no longer matches what was reviewed — so if
 * someone edits an account between review and run, this stops rather than
 * deleting the wrong thing.
 *
 * WHY THIS RUNS BEFORE merge-by-canonical.
 * `loyesox763@jobbrett.com@u.nus.edu` stores userID "E1234567", which is the
 * CANONICAL id of a different group (the three e1234567@u.nus.edu rows). The
 * merge aborts on that collision — correctly, since merging would put two
 * identities on one key. Removing the junk clears the block.
 *
 * DELETION IS NOT REVERSIBLE BY RE-RUNNING. The backup below is the only way
 * back, so it is written before the first write and the run aborts if it
 * cannot be written.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inspectWriteReply, isCommit, abort, fileStamp } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

/**
 * Reviewed 2026-07-19 against the full 1242-row census. `email` is asserted at
 * run time; `keys` are every identifier dependent rows could be keyed on for
 * that account — the canonical id derived from the email, and the stored
 * `User.userID` (an A-format matric on most of these).
 */
const TARGETS = [
  { id: "5fe19392c5e879228c9b9791", email: "a1237b@u.nus.edu", keys: ["A1237B", "A1234567B"], note: "Abby Tan — test" },
  { id: "60241a09b29978d45754aa6b", email: "e111@u.nus.edu", keys: ["E111", "A0123460X"], note: "Brandon Cheng — test" },
  { id: "6047a6983272fcf98f9110b3", email: "a1234567@u.nus.edu", keys: ["A1234567", "A1234567C"], note: "Cabby Tan — test" },
  { id: "606dac3a6c0b9bf229783ab7", email: "test@u.nus.edu", keys: ["TEST", "A1023294M"], note: "Test" },
  { id: "61793920f01e36470ea6bd22", email: "e1234567@u.nus.edu", keys: ["E1234567", "A0123456Z"], note: "Mohamad Sunuy — test" },
  { id: "61c82308f0a85df2229d3875", email: "e1234567@u.nus.edu", keys: ["E1234567", "A8888882B"], note: "haha — test" },
  { id: "6203ed9953e82bc76fcc871a", email: "e1234567@u.nus.edu", keys: ["E1234567", "A8888888B"], note: "haha — test" },
  { id: "644de830bb62cf0b1355bf8d", email: "loyesox763@jobbrett.com@u.nus.edu", keys: ["E1234567"], note: "bleh — junk; BLOCKS the merge" },
  { id: "644e55fbbb62cf0b1355bf9e", email: "aaaaaa@u.nus.edu", keys: ["AAAAAA", "E1234566"], note: "mao tan ah beng — test" },
  { id: "644e5614bb62cf0b1355bf9f", email: "aaaaaa@u.nus.edu", keys: ["AAAAAA", "E1234565"], note: "mao tan ah beng — test" },
  { id: "67b0326116642b244a8b3eda", email: "test@u.nus.edu", keys: ["TEST", "E0123321"], note: "test" },
];

/** Collections whose rows belong to a user and go with them. */
const DEPENDENTS = ["Bookings", "UserCCA", "Gym", "Order", "Posts", "BookingLogs", "UserRole", "UserMatric", "ProfileCompletion", "CcaHead"];

const raw = (cmd) => db.$runCommandRaw(cmd);
const oid = (s) => ({ $oid: s });

async function findByIds(ids) {
  const r = await raw({ find: "User", filter: { _id: { $in: ids.map(oid) } }, limit: ids.length + 5 });
  return r?.cursor?.firstBatch ?? [];
}

async function rowsFor(collection, keys) {
  const r = await raw({ find: collection, filter: { userID: { $in: keys } }, limit: 5000, batchSize: 5000, singleBatch: true });
  return r?.cursor?.firstBatch ?? [];
}

async function main() {
  console.log(`\n=== purge-test-accounts.mjs ===`);
  console.log(`MODE: ${COMMIT ? "COMMIT (writes)" : "DRY RUN (no writes)"}`);
  console.log(`at:   ${new Date().toISOString()}\n`);

  const found = await findByIds(TARGETS.map((t) => t.id));
  const byId = new Map(found.map((u) => [String(u._id?.$oid ?? u._id), u]));

  // --- precondition: every target still looks like what was reviewed --------
  const problems = [];
  for (const t of TARGETS) {
    const u = byId.get(t.id);
    if (!u) { problems.push(`${t.id} NOT FOUND (already deleted?)`); continue; }
    if (String(u.email ?? "").trim().toLowerCase() !== t.email) {
      problems.push(`${t.id} email is ${JSON.stringify(u.email)}, reviewed as ${JSON.stringify(t.email)}`);
    }
  }
  if (problems.length) {
    console.log("PRECONDITION FAILURES:");
    for (const p of problems) console.log(`  ${p}`);
    return abort("targets do not match what was reviewed. Re-run the census and re-review before deleting anything.");
  }

  // --- safety: no key may be shared with a User NOT on the list ------------
  // A dependent row is deleted by KEY, so a key that another account also uses
  // would take that account's rows with it.
  const allKeys = [...new Set(TARGETS.flatMap((t) => t.keys))];
  const sharers = await raw({
    find: "User",
    filter: { userID: { $in: allKeys }, _id: { $nin: TARGETS.map((t) => oid(t.id)) } },
    projection: { email: 1, userID: 1 },
    limit: 50,
  });
  const shared = sharers?.cursor?.firstBatch ?? [];
  if (shared.length) {
    console.log("KEY COLLISION — these Users are NOT on the delete list but share a key with one that is:");
    for (const u of shared) console.log(`  _id=${u._id?.$oid} email=${JSON.stringify(u.email)} userID=${JSON.stringify(u.userID)}`);
    return abort("refusing to delete dependent rows by a key another account also uses.");
  }

  // --- plan ----------------------------------------------------------------
  const backup = { at: new Date().toISOString(), users: found, dependents: {} };
  let depTotal = 0;
  console.log(`--- PLAN (${TARGETS.length} account(s)) ---\n`);
  for (const t of TARGETS) {
    const u = byId.get(t.id);
    const counts = [];
    for (const c of DEPENDENTS) {
      const rows = await rowsFor(c, t.keys);
      if (rows.length) {
        backup.dependents[c] = (backup.dependents[c] ?? []).concat(rows);
        counts.push(`${c}=${rows.length}`);
        depTotal += rows.length;
      }
    }
    console.log(`  - ${t.email.padEnd(36)} ${String(u.displayName ?? "").padEnd(18)} keys=[${t.keys.join(", ")}]`);
    console.log(`      ${t.note}`);
    console.log(`      dependents: ${counts.length ? counts.join(" ") : "(none)"}`);
  }
  console.log(`\n  Users to delete:      ${TARGETS.length}`);
  console.log(`  Dependent rows:       ${depTotal}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing was written. Re-run with --commit to apply.\n`);
    return;
  }

  // --- backup BEFORE the first write --------------------------------------
  const out = path.join(process.cwd(), "scripts", "remediation", "backups", `purge-test-accounts-${fileStamp()}.json`);
  try {
    writeFileSync(out, JSON.stringify(backup, null, 2), "utf8");
    console.log(`\nBackup written: ${out}`);
  } catch (e) {
    return abort(`could not write the backup (${String(e?.message ?? e)}). Refusing to delete without one.`);
  }

  // --- apply: dependents first, then the User rows -------------------------
  // Dependents first so a crash leaves an orphaned User (harmless, re-runnable)
  // rather than orphaned rows whose owner is gone (07 §5.1).
  let failures = 0;
  for (const c of DEPENDENTS) {
    const keys = allKeys;
    const reply = await raw({ delete: c, deletes: [{ q: { userID: { $in: keys } }, limit: 0 }] });
    const r = inspectWriteReply(reply, c);
    if (!r.ok) { failures++; console.log(`  ! ${c}: ${r.errmsg}`); }
    else if (r.n) console.log(`  - ${c}: deleted ${r.n}`);
  }
  const uReply = await raw({ delete: "User", deletes: [{ q: { _id: { $in: TARGETS.map((t) => oid(t.id)) } }, limit: 0 }] });
  const uRes = inspectWriteReply(uReply, "User");
  if (!uRes.ok) { failures++; console.log(`  ! User: ${uRes.errmsg}`); }
  else console.log(`  - User: deleted ${uRes.n}`);

  // --- verify --------------------------------------------------------------
  const left = await findByIds(TARGETS.map((t) => t.id));
  console.log(`\n=== VERIFY ===`);
  console.log(`User rows remaining from the list: ${left.length}`);
  for (const u of left) console.log(`  STILL PRESENT _id=${u._id?.$oid} email=${JSON.stringify(u.email)}`);
  console.log(`writeErrors: ${failures}`);
  if (failures || left.length) return abort("purge did not complete cleanly — see above. The backup holds every pre-image.");
  console.log(`\nDone. merge-by-canonical.mjs should no longer block on E1234567.\n`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
