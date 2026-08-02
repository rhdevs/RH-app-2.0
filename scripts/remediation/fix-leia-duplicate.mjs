/**
 * One-off: collapse a duplicate account created by a typo'd sign-up email.
 *
 *   node scripts/remediation/fix-leia-duplicate.mjs            # dry run
 *   node scripts/remediation/fix-leia-duplicate.mjs --commit    # apply
 *
 * THE SITUATION. One person, two User rows:
 *
 *   A  e1514199@u.nus.edu   displayName "Ganzon Leia Plaza"   User.userID E1524199
 *   B  e1524199@u.nus.edu   displayName "leia"                User.userID E1524199
 *
 * `1514199` is a typo of her NUSNET `1524199`. Session identity is derived from
 * the EMAIL (canonicalUserID in src/server/auth.ts), never from the stored
 * `User.userID`, so A logs in as E1514199 — an identity that owns one baseline
 * `resident` row and nothing else — while every real thing she has (matric
 * A0321292M, cca_head of CCAs 7 and 46, membership of 47, two bookings, an
 * accepted application) is keyed E1524199, i.e. B.
 *
 * Action: give B her full name, delete A.
 *
 * ############################################################################
 * # WHY THIS DOES NOT CALL deleteUserCascade().                              #
 * #                                                                          #
 * # A's STORED User.userID is E1524199 — B's key, not its own. deleteUser-   #
 * # Cascade(db, userID) deletes Bookings, Posts, Order, UserCCA and Gym BY   #
 * # THAT STRING, so calling it for A would delete B's bookings, B's          #
 * # membership and B's data, and then `user.deleteMany({ userID })` would    #
 * # take BOTH rows. The whole reason this account is broken — a stored key   #
 * # that disagrees with the email — is also what makes the ordinary delete   #
 * # helper catastrophic here.                                                #
 * #                                                                          #
 * # This script deletes A BY ITS ObjectId, and by nothing else. Session /    #
 * # Account / Authenticator carry onDelete: Cascade on their User relation,  #
 * # so those follow the row automatically.                                   #
 * ############################################################################
 *
 * The gates below refuse to proceed unless the situation is still EXACTLY as
 * described — one row per address, distinct ids, and A's own canonical key
 * owning nothing but role rows. If she has logged in as A since this was
 * written and acquired a matric or a booking under E1514199, that is no longer
 * a delete, it is a merge, and this script stops rather than losing it.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { isCommit, abort, banner, fileStamp, inspectWriteReply } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

const DOOMED_EMAIL = "e1514199@u.nus.edu"; // A — the typo
const KEEP_EMAIL = "e1524199@u.nus.edu"; // B — the real account
const DOOMED_KEY = "E1514199"; // A's canonical key, derived from its email
const KEEP_KEY = "E1524199"; // B's canonical key — MUST survive untouched
const NEW_DISPLAY_NAME = "Ganzon Leia Plaza";

/** Collections keyed by the canonical userID string. */
const KEYED = [
  "UserMatric",
  "UserRole",
  "UserCCA",
  "CcaHead",
  "CcaApplication",
  "CcaInterviewSlot",
  "Bookings",
  "Posts",
  "Order",
  "Gym",
  "ProfileCompletion",
];
/** Of those, the ones A is ALLOWED to own — a baseline role row is expected and
 *  is deleted with it. Anything else means real data lives under A. */
const DISPOSABLE = new Set(["UserRole"]);

const FIELD = { CcaInterviewSlot: "bookedByUserID" };

async function ownedBy(key) {
  const out = new Map();
  for (const coll of KEYED) {
    const field = FIELD[coll] ?? "userID";
    const r = await db.$runCommandRaw({
      find: coll,
      filter: { [field]: key },
      batchSize: 200,
      singleBatch: true,
    });
    const rows = r?.cursor?.firstBatch ?? [];
    if (rows.length) out.set(coll, rows);
  }
  return out;
}

const brief = (m) =>
  [...m.entries()].map(([c, r]) => `${c}=${r.length}`).join(", ") || "(nothing)";

async function main() {
  banner("fix-leia-duplicate.mjs", COMMIT);

  /* --- resolve both rows, refusing anything ambiguous --------------------- */
  const rows = await db.user.findMany({
    where: { email: { in: [DOOMED_EMAIL, KEEP_EMAIL], mode: "insensitive" } },
    select: {
      id: true,
      email: true,
      userID: true,
      displayName: true,
      block: true,
      telegramHandle: true,
      bio: true,
    },
  });
  const A = rows.filter((r) => r.email.toLowerCase() === DOOMED_EMAIL);
  const B = rows.filter((r) => r.email.toLowerCase() === KEEP_EMAIL);

  const bad = [];
  if (A.length !== 1) bad.push(`${DOOMED_EMAIL}: ${A.length} row(s), expected exactly 1`);
  if (B.length !== 1) bad.push(`${KEEP_EMAIL}: ${B.length} row(s), expected exactly 1`);
  if (bad.length) {
    for (const b of bad) console.error(`  BLOCK  ${b}`);
    return abort("the two accounts are not in the shape this script was written against.");
  }
  const a = A[0];
  const b = B[0];
  if (a.id === b.id) return abort("both addresses resolved to the SAME row — nothing to delete.");

  console.log(`A (delete)  _id=${a.id}  ${a.email}`);
  console.log(`              displayName=${JSON.stringify(a.displayName)}  stored userID=${a.userID}`);
  console.log(`B (keep)    _id=${b.id}  ${b.email}`);
  console.log(`              displayName=${JSON.stringify(b.displayName)}  stored userID=${b.userID}`);

  /* --- what each canonical key owns -------------------------------------- */
  const ownedA = await ownedBy(DOOMED_KEY);
  const ownedB = await ownedBy(KEEP_KEY);
  console.log(`\nowned by ${DOOMED_KEY} (A's login identity): ${brief(ownedA)}`);
  console.log(`owned by ${KEEP_KEY} (B's, must be untouched): ${brief(ownedB)}`);

  const keepsRealData = [...ownedA.keys()].filter((c) => !DISPOSABLE.has(c));
  if (keepsRealData.length) {
    for (const c of keepsRealData) {
      console.error(`  BLOCK  ${DOOMED_KEY} owns ${ownedA.get(c).length} ${c} row(s) — deleting A would lose it`);
    }
    return abort(
      `A's identity now owns real data. That is a MERGE, not a delete — use ` +
        `merge-by-canonical.mjs / dedupe-users.mjs instead of this script.`,
    );
  }

  /* --- plan --------------------------------------------------------------- */
  const roleRows = ownedA.get("UserRole") ?? [];
  console.log(`\n--- PLAN ---`);
  console.log(`  ~ B.displayName: ${JSON.stringify(b.displayName)} -> ${JSON.stringify(NEW_DISPLAY_NAME)}`);
  console.log(`  - delete User _id=${a.id} (BY ObjectId — never by userID, see the header)`);
  console.log(`  - delete ${roleRows.length} UserRole row(s) keyed ${DOOMED_KEY}: ${JSON.stringify(roleRows.map((r) => r.roles ?? r.role))}`);
  console.log(`  = Session/Account/Authenticator for that _id follow via onDelete: Cascade`);
  console.log(`  = everything keyed ${KEEP_KEY} is untouched: ${brief(ownedB)}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.\n`);
    return;
  }

  /* --- backup, before the first write ------------------------------------- */
  // NOTE: contains A's passwordHash. scripts/remediation/backups/ is gitignored.
  const full = await db.$runCommandRaw({
    find: "User",
    filter: { _id: { $oid: a.id } },
    batchSize: 5,
    singleBatch: true,
  });
  const sessions = await db.$runCommandRaw({
    find: "Session",
    filter: { userId: { $oid: a.id } },
    batchSize: 50,
    singleBatch: true,
  });
  const accounts = await db.$runCommandRaw({
    find: "Account",
    filter: { userId: { $oid: a.id } },
    batchSize: 50,
    singleBatch: true,
  });
  const out = path.join(
    process.cwd(),
    "scripts",
    "remediation",
    "backups",
    `fix-leia-duplicate-${fileStamp()}.json`,
  );
  try {
    writeFileSync(
      out,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          deletedUser: full?.cursor?.firstBatch ?? [],
          deletedSessions: sessions?.cursor?.firstBatch ?? [],
          deletedAccounts: accounts?.cursor?.firstBatch ?? [],
          deletedUserRoles: roleRows,
          keptUserBefore: b,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`\nBackup written: ${out}`);
  } catch (e) {
    return abort(`could not write the backup (${String(e?.message ?? e)}). Refusing to proceed.`);
  }

  /* --- apply -------------------------------------------------------------- */
  let failures = 0;
  await db.user.update({
    where: { id: b.id },
    data: { displayName: NEW_DISPLAY_NAME },
  });
  console.log(`  ~ renamed B -> ${JSON.stringify(NEW_DISPLAY_NAME)}`);

  if (roleRows.length) {
    const reply = await db.$runCommandRaw({
      delete: "UserRole",
      deletes: [{ q: { userID: DOOMED_KEY }, limit: 0 }],
    });
    const r = inspectWriteReply(reply, "delete UserRole");
    if (r.writeErrors.length || r.writeConcernError.length) {
      failures++;
      console.error(`  ! ${JSON.stringify([...r.writeErrors, ...r.writeConcernError]).slice(0, 200)}`);
    } else {
      console.log(`  - deleted ${r.n} UserRole row(s) keyed ${DOOMED_KEY}`);
    }
  }

  // BY ObjectId. Never `deleteMany({ userID })` — see the header.
  await db.user.delete({ where: { id: a.id } });
  console.log(`  - deleted User _id=${a.id}`);

  /* --- verify -------------------------------------------------------------- */
  console.log(`\n=== VERIFY ===`);
  const aGone = await db.user.findUnique({ where: { id: a.id }, select: { id: true } });
  console.log(`  A row gone:              ${aGone === null}`);
  if (aGone !== null) failures++;

  const kept = await db.user.findUnique({
    where: { id: b.id },
    select: { id: true, email: true, displayName: true, userID: true, block: true, telegramHandle: true },
  });
  console.log(`  B row: ${JSON.stringify(kept)}`);
  if (!kept || kept.displayName !== NEW_DISPLAY_NAME) failures++;

  const ownedAfter = await ownedBy(KEEP_KEY);
  console.log(`  owned by ${KEEP_KEY} after: ${brief(ownedAfter)}`);
  for (const coll of new Set([...ownedB.keys(), ...ownedAfter.keys()])) {
    const before = ownedB.get(coll)?.length ?? 0;
    const after = ownedAfter.get(coll)?.length ?? 0;
    if (before !== after) {
      failures++;
      console.error(`  ! ${coll}: ${before} -> ${after} — B LOST DATA, restore from the backup`);
    }
  }
  const strayRoles = await ownedBy(DOOMED_KEY);
  console.log(`  owned by ${DOOMED_KEY} after: ${brief(strayRoles)} (must be nothing)`);
  if (strayRoles.size) failures++;

  const leftoverSessions = await db.$runCommandRaw({
    find: "Session",
    filter: { userId: { $oid: a.id } },
    batchSize: 5,
    singleBatch: true,
  });
  const nS = (leftoverSessions?.cursor?.firstBatch ?? []).length;
  console.log(`  orphaned Session rows:   ${nS} (cascade should have taken them)`);

  console.log(`\nfailures: ${failures}`);
  if (failures) return abort("did not complete cleanly — the backup holds every pre-image.");
  console.log(`\nDone.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
