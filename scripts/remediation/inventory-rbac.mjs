/**
 * PHASE 1 INVENTORY — the read-only census that must be run and triaged BEFORE
 * anything writes. Covers doc 01 Steps 1, 3, 4 and 5 in one pass so the whole
 * population is described from ONE consistent read of the database.
 *
 *   node scripts/remediation/inventory-rbac.mjs
 *   node scripts/remediation/inventory-rbac.mjs --admin-email you@u.nus.edu
 *
 * READ-ONLY. There is no --commit flag and no code path that writes to the
 * database. It writes one JSON report to backups/.
 *
 * Sections:
 *   [1] Step 1  — verify the canonical admin userID (D-4 says E1633673)
 *   [2] Step 3  — identity census: non-NUS, blank, collisions, plus-addressed,
 *                 whitespace, non-E-format, missingPasswordHash, oauth providers
 *   [3] Step 4  — canonical RE-KEY audit across ALL FOUR ownership collections
 *                 (UserMatric, UserRole, Bookings, UserCCA) — BLOCKING
 *   [4] Step 5  — facility enumeration + a starter facility-roles.json
 *   [5] Step 3  — UserCCA key-format census (input to 07-cca-future.md)
 *
 * EXIT CODE. 1 if any BLOCKING condition holds — today that is exactly the
 * Step 4 orphan set, because an orphan means a live user loses their bookings,
 * their matric or their roles the moment the anchored canonicalUserID ships.
 * Everything else is reported for human triage and does NOT fail the run: a
 * gate that can never reach zero gets commented out, which deletes the detector
 * (I-16 corollary).
 *
 * $runCommandRaw with an explicit projection THROUGHOUT. Never
 * db.user.findMany() without a select: User.passwordHash is a required
 * non-nullable scalar while PrismaAdapter creates Google rows without it, so an
 * unprojected typed read throws for the whole collection (I-2, lockout mode 21).
 * passwordHash is never selected here — only counted server-side.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUserID } from "./lib/identity.mjs";
import {
  findAll, countWhere, numify, E_FORMAT, SENTINEL_FACILITY_ID,
  legacyCanonicalUserID, fileStamp, abort,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

const argIdx = process.argv.indexOf("--admin-email");
const ADMIN_EMAIL = argIdx >= 0 ? process.argv[argIdx + 1] : process.env.ADMIN_EMAIL;
const EXPECTED_ADMIN_ID = process.env.ADMIN_USER_ID ?? "E1633673";   // D-4

const A_FORMAT = /^A\d{7}[A-Z]$/i;
const report = { at: new Date().toISOString() };
const blocking = [];

// ---------------------------------------------------------------------------
// [1] Step 1 — the canonical admin userID
// ---------------------------------------------------------------------------
async function step1() {
  console.log(`\n--- [1] admin identity (D-4 expects ${EXPECTED_ADMIN_ID}) ---`);
  if (!ADMIN_EMAIL) {
    console.warn(`  (skipped) pass --admin-email <you@u.nus.edu> to verify D-4.`);
    report.admin = { skipped: true };
    return;
  }
  const canonical = canonicalUserID(ADMIN_EMAIL);
  console.log(`derived canonical userID: ${JSON.stringify(canonical)}`);

  // Never select passwordHash — see the header.
  const rows = await findAll(db, "User", { _id: 1, email: 1, userID: 1, displayName: 1 });
  const hit = rows.find((u) => String(u.email ?? "").trim().toLowerCase() === String(ADMIN_EMAIL).trim().toLowerCase());
  console.log(`User row: ${hit ? JSON.stringify({ email: hit.email, userID: hit.userID, displayName: hit.displayName }) : "NOT FOUND"}`);
  console.log(`User.userID (LEGACY A-format matric on ~515 rows — NEVER the role key, I-1): ${hit?.userID ?? null}`);

  const matric = (await raw({ find: "UserMatric", filter: { userID: canonical }, limit: 1 }))?.cursor?.firstBatch?.[0];
  console.log(`UserMatric row for canonical id: ${matric ? JSON.stringify(matric.matric) : "none"}`);

  report.admin = { email: ADMIN_EMAIL, canonical, found: !!hit, legacyUserID: hit?.userID ?? null };

  if (canonical === "") {
    console.error(`  ! STOP: ${ADMIN_EMAIL} is not an @u.nus.edu address. Under D-7 this account`);
    console.error(`    cannot sign in AT ALL, and it can never hold a stored resident baseline`);
    console.error(`    (I-8d). Resolve this before any seeding.`);
  } else if (canonical !== EXPECTED_ADMIN_ID) {
    console.error(`  ! STOP: derived ${canonical} but D-4 says ${EXPECTED_ADMIN_ID}.`);
    console.error(`    Use the DERIVED value in ADMIN_USER_ID everywhere below, or correct D-4.`);
  } else {
    console.log(`  OK — matches D-4.`);
  }
}

// ---------------------------------------------------------------------------
// [2] Step 3 — identity census
// ---------------------------------------------------------------------------
async function step3(users) {
  console.log(`\n--- [2] identity census (${users.length} User rows) ---`);

  const nonNus = [], blank = [], plusAddr = [], whitespace = [], nonE = [];
  const byCanonical = new Map(), collisions = [];
  for (const u of users) {
    const e = String(u.email ?? "");
    if (e !== e.trim()) whitespace.push({ _id: u._id, email: e });
    if (/\+/.test(e)) plusAddr.push(e);
    const id = canonicalUserID(e);
    if (!id) { (e.trim() ? nonNus : blank).push({ _id: u._id, email: e, name: u.displayName ?? null }); continue; }
    if (!E_FORMAT.test(id)) nonE.push(id);                 // INFORMATIONAL — never an exclusion
    if (byCanonical.has(id)) collisions.push({ id, emails: [byCanonical.get(id), e] });
    else byCanonical.set(id, e);
  }

  // Counted server-side so passwordHash never crosses the wire.
  const missingPasswordHash = await countWhere(db, "User", { passwordHash: { $exists: false } });
  let oauthProviders = [];
  try { oauthProviders = (await raw({ distinct: "Account", key: "provider" }))?.values ?? []; } catch { /* collection may not exist */ }

  const census = {
    totalUsers: users.length,
    eligible: byCanonical.size,
    nonNus: nonNus.length,
    blankEmail: blank.length,
    canonicalCollisions: collisions.length,
    nonEFormatCanonical: nonE.length,
    plusAddressed: plusAddr.length,
    whitespaceEmails: whitespace.length,
    missingPasswordHash,
    oauthProviders,
  };
  console.log(census);

  // I-16: NAME the offenders. A bare count cannot be acted on.
  if (nonNus.length) {
    console.warn(`\n  NON-NUS ROWS (D-7: these accounts cannot sign in; AuthAllowlist restores`);
    console.warn(`  SIGN-IN ONLY — they canonicalise to "" and can never hold resident, so they`);
    console.warn(`  still cannot book). If YOUR admin account is in this list, STOP:`);
    for (const r of nonNus) console.warn(`    ${r.email}  (${r.name ?? "no name"})`);
  }
  if (blank.length) {
    console.warn(`\n  BLANK EMAIL (already broken — user.ts:87-90 throws for them; repair or`);
    console.warn(`  delete, do NOT backfill):`);
    for (const r of blank) console.warn(`    _id ${JSON.stringify(r._id)}`);
  }
  if (collisions.length) {
    console.warn(`\n  CANONICAL COLLISIONS — two User rows collapse to one role key. Merged-`);
    console.warn(`  account residue (merge-accounts.mjs, 568c51c/fe9afe8). RESOLVE BEFORE the`);
    console.warn(`  resident backfill: it exits 1 rather than guessing, so an unresolved`);
    console.warn(`  collision means one of two merged humans gets NO baseline at all:`);
    for (const c of collisions) console.warn(`    ${c.id}: ${c.emails.join("  <->  ")}`);
  }
  if (whitespace.length) {
    console.warn(`\n  WHITESPACE EMAILS — the new .trim() RE-KEYS these users. Section [3] below`);
    console.warn(`  enumerates their orphaned rows:`);
    for (const r of whitespace) console.warn(`    ${JSON.stringify(r.email)}`);
  }
  if (plusAddr.length) {
    console.warn(`\n  PLUS-ADDRESSED — decide explicitly (relax the regex, or allowlist and`);
    console.warn(`  re-key). Do not discover this in production:`);
    for (const e of plusAddr) console.warn(`    ${e}`);
  }
  if (nonE.length) {
    console.log(`\n  NON-E-FORMAT CANONICAL IDS — INFORMATIONAL, NOT A FAULT. These are real`);
    console.log(`  eligible accounts (L-27) and must NEVER be excluded from the resident`);
    console.log(`  backfill; excluding them withholds the baseline permanently:`);
    console.log(`    ${nonE.join(", ")}`);
  }
  if (missingPasswordHash > 0) {
    console.warn(`\n  ! ${missingPasswordHash} User row(s) have no passwordHash. You MUST change`);
    console.warn(`    prisma/schema.prisma to \`passwordHash String?\` in the SAME db push as the`);
    console.warn(`    Step 7 diff. Without it doc 02's session-callback db.user.findUnique throws`);
    console.warn(`    and logs those users out. Read-side only; no validator is touched.`);
  }

  report.census = { ...census, nonNus, blank, collisions, whitespace, plusAddr, nonEFormatCanonical: nonE };
  report.eligibleIDs = [...byCanonical.keys()];
  return byCanonical;
}

// ---------------------------------------------------------------------------
// [3] Step 4 — canonical re-key audit. BLOCKING.
// ---------------------------------------------------------------------------
//
// The canonical userID is the OWNERSHIP key on four collections, not one.
// Adopting the anchored canonicalUserID changes the derived key for any email
// that is not exactly X@u.nus.edu, and the cost is not cosmetic:
//   UserMatric -> thrown back into the matric gate
//   UserRole   -> loses every granted role
//   Bookings   -> EVERY existing booking vanishes AND deleteBooking's ownership
//                 check (facilitiesBooking.ts:384) fails, so they cannot even
//                 cancel their own bookings
//   UserCCA    -> loses CCA membership
const OWNERSHIP_COLLECTIONS = ["UserMatric", "UserRole", "Bookings", "UserCCA"];

async function step4(users) {
  console.log(`\n--- [3] canonical re-key audit (BLOCKING) ---`);

  const changed = [];
  for (const u of users) {
    const oldKey = legacyCanonicalUserID(u.email);
    const newKey = canonicalUserID(u.email);
    if (oldKey !== newKey) changed.push({ email: String(u.email ?? ""), oldKey, newKey });
  }
  console.log(`emails whose derived key CHANGES: ${changed.length}`);

  const orphans = [];
  for (const c of changed) {
    if (!c.oldKey) continue;                    // nothing could ever be keyed on ""
    for (const coll of OWNERSHIP_COLLECTIONS) {
      const docs = await drainKeyed(coll, c.oldKey);
      if (!docs.length) continue;
      orphans.push({ collection: coll, oldKey: c.oldKey, newKey: c.newKey, email: c.email, count: docs.length, docs });
    }
  }

  console.log(`\n  ${"collection".padEnd(12)} ${"oldKey".padEnd(20)} -> newKey            rows`);
  for (const o of orphans) {
    console.error(`  ORPHAN ${o.collection.padEnd(12)} ${String(o.oldKey).padEnd(20)} -> ${String(o.newKey || '""').padEnd(18)} ${o.count}`);
    // Name the actual documents, not a count (I-16). For Bookings that means
    // the bookingIDs, because those are what a user will phone up about.
    if (o.collection === "Bookings") {
      console.error(`         bookingIDs: ${o.docs.map((d) => numify(d.bookingID)).join(", ")}`);
    } else {
      console.error(`         _ids: ${o.docs.map((d) => JSON.stringify(d._id)).join(", ")}`);
    }
  }
  if (!orphans.length) console.log(`  none — zero orphans across ${OWNERSHIP_COLLECTIONS.join(", ")}.`);

  report.rekey = { changed, orphans: orphans.map(({ docs, ...rest }) => rest) };

  if (orphans.length) {
    blocking.push(
      `${orphans.length} orphan group(s) under the OLD key. Deploy of Phase 2 is BLOCKED. ` +
      `Run: node scripts/remediation/rekey-canonical.mjs (dry run), review, then --commit, ` +
      `then re-run this inventory until it prints zero.`);
  }
}

/** Collect every document in `coll` keyed on this exact userID string. */
async function drainKeyed(coll, userID) {
  const r = await db.$runCommandRaw({
    find: coll, filter: { userID }, projection: { _id: 1, userID: 1, bookingID: 1 }, batchSize: 1000,
  });
  return r?.cursor?.firstBatch ?? [];
}

// ---------------------------------------------------------------------------
// [4] Step 5 — facility enumeration
// ---------------------------------------------------------------------------
async function step5() {
  console.log(`\n--- [4] facilities ---`);
  const facilities = (await findAll(db, "Facilities", { facilityID: 1, facilityName: 1, facilityLocation: 1 }))
    .map((f) => ({ ...f, facilityID: numify(f.facilityID) }))
    .sort((a, b) => a.facilityID - b.facilityID);
  const access = await findAll(db, "FacilityAccess", { facilityID: 1, requiredRole: 1, requiredRoles: 1 });
  const byID = new Map(access.map((a) => [numify(a.facilityID), a]));

  console.log(`Facilities: ${facilities.length}   FacilityAccess rows: ${access.length}`);
  for (const f of facilities) {
    const a = byID.get(f.facilityID);
    const sentinel = f.facilityID === SENTINEL_FACILITY_ID ? "  [SENTINEL — excluded]" : "";
    console.log(`  ${String(f.facilityID).padStart(4)}  ${String(f.facilityName ?? "").padEnd(28)} ` +
      `${String(f.facilityLocation ?? "").padEnd(18)} ` +
      `requiredRoles=${JSON.stringify(a?.requiredRoles ?? null)} legacy=${JSON.stringify(a?.requiredRole ?? null)}${sentinel}`);
  }

  // D-1: gating class CANNOT be derived — Facilities has only facilityID,
  // facilityLocation, facilityName. A human must classify these by hand and a
  // SECOND human must review it, because under D-1 a mistake LOCKS a room.
  const template = {
    _comment: "facilityID -> requiredRoles. Facilities NOT listed here get [\"resident\"]. " +
      "facilityID -1 is the Calender_v2.tsx:306 sentinel and is excluded entirely. " +
      "Allowed values: resident | jcrc | cca_head. NEVER \"admin\" — admin is an implicit bypass, never stored.",
    _reviewedBy: null,
    _reviewedAt: null,
    byFacilityID: Object.fromEntries(
      facilities.filter((f) => f.facilityID !== SENTINEL_FACILITY_ID)
        .map((f) => [String(f.facilityID), byID.get(f.facilityID)?.requiredRoles?.length
          ? byID.get(f.facilityID).requiredRoles
          : (byID.get(f.facilityID)?.requiredRole ? [byID.get(f.facilityID).requiredRole] : ["resident"])]),
    ),
  };
  report.facilities = facilities;
  report.facilityRolesTemplate = template;

  console.log(`\n  A STARTER data/facility-roles.json is in the report file under`);
  console.log(`  "facilityRolesTemplate". It is seeded from TODAY'S gating, which is`);
  console.log(`  open-by-default — it is a starting point, NOT a classification.`);
  console.log(`  Copy it to scripts/remediation/data/facility-roles.json, CLASSIFY each`);
  console.log(`  room, then set _reviewedBy/_reviewedAt. seed-roles-v2.mjs REFUSES to`);
  console.log(`  commit while _reviewedBy is null.`);

  // 07-cca-future.md reserves ccaID 0 as "no CCA"; confirm nothing uses it.
  const ccaZero = await countWhere(db, "CCA", { ccaID: 0 });
  console.log(`\n  CCA rows with ccaID 0 (must be 0 to reserve it as "no CCA", see 07): ${ccaZero}`);
  report.ccaZero = ccaZero;
}

// ---------------------------------------------------------------------------
// [5] Step 3 — UserCCA key-format census (blocking input for doc 07, not here)
// ---------------------------------------------------------------------------
async function step5b() {
  console.log(`\n--- [5] UserCCA key-format census (input to 07-cca-future.md) ---`);
  const cca = await findAll(db, "UserCCA", { ccaID: 1, userID: 1 });
  const eFmt = cca.filter((r) => E_FORMAT.test(String(r.userID ?? "")));
  const aFmt = cca.filter((r) => A_FORMAT.test(String(r.userID ?? "")));
  const other = cca.filter((r) => !E_FORMAT.test(String(r.userID ?? "")) && !A_FORMAT.test(String(r.userID ?? "")));

  const seen = new Set(), dup = [];
  for (const r of cca) {
    const k = `${numify(r.ccaID)}|${r.userID}`;
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  }
  console.log(`UserCCA total: ${cca.length}   E-format: ${eFmt.length}   A-format: ${aFmt.length}   other: ${other.length}`);
  console.log(`duplicate (ccaID,userID) pairs: ${dup.length}`);
  if (aFmt.length) console.warn(`  A-format userIDs present — these rows are keyed on a MATRIC, not the`);
  if (aFmt.length) console.warn(`  canonical id. Record in 07-cca-future.md. Does NOT block this phase.`);
  if (dup.length) console.warn(`  duplicate pairs: ${dup.slice(0, 20).join(", ")}${dup.length > 20 ? ` (+${dup.length - 20} more)` : ""}`);
  report.userCCA = { total: cca.length, eFormat: eFmt.length, aFormat: aFmt.length, other: other.length, duplicates: dup };
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== inventory-rbac.mjs (READ-ONLY) ===`);
  console.log(`at: ${new Date().toISOString()}`);

  await step1();
  const users = await findAll(db, "User", { _id: 1, email: 1, userID: 1, displayName: 1, block: 1 });
  await step3(users);
  await step4(users);
  await step5();
  await step5b();

  mkdirSync(join(HERE, "backups"), { recursive: true });
  const path = join(HERE, "backups", `identity-census-${fileStamp()}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${path}`);
  console.log(`(contains emails and display names — backups/ MUST stay gitignored, doc 01 Step 0)`);

  console.log(`\n================================`);
  if (blocking.length) {
    for (const b of blocking) console.error(`  BLOCK  ${b}`);
    abort(`${blocking.length} blocking condition(s).`);
    return;
  }
  console.log(`No blocking conditions. Triage the warnings above with the user before Step 6.`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
