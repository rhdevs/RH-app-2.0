/**
 * D-6 GATE: prove the legacy scalars `role` / `requiredRole` carry no
 * information not already present in `roles` / `requiredRoles`, so that
 * dropping them is LOSSLESS.
 *
 *   node scripts/remediation/verify-legacy-drop.mjs
 *
 * READ-ONLY. There is no --commit flag. Exit 0 = the drop is permitted, and a
 * pass-marker is written to backups/gate-pass-<ISO>.json which
 * drop-legacy-role-fields.mjs REFUSES to run without. Exit 1 = DO NOT DROP.
 *
 * VALIDITY WINDOW — READ THIS BEFORE RE-RUNNING. Run this WHILE THE DUAL-WRITE
 * IS STILL DEPLOYED, i.e. BEFORE cutover step 5c. After the dual-write is
 * removed, a legitimately-edited document carries a STALE-but-harmless scalar
 * (an admin demoted to jcrc has roles:["jcrc"], role:"admin") and B2 reports a
 * FALSE failure. Do NOT re-run this as a gate post-5c and conclude the
 * migration corrupted data — post-drop verification is a different, simpler set
 * of queries (doc 06 §5 step 6). Only the COVERAGE half stays valid after.
 *
 * $runCommandRaw throughout, for the same reason backfill-roles-v2.mjs uses it:
 * a typed Prisma read of a document mid-migration can throw, and this script's
 * entire job is to run against exactly that state.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUserID, isCanonicalResidentID } from "./lib/identity.mjs";
import {
  findAll, countWhere, numify, legacyMirrorOrNull, ROLE_VOCAB, SENTINEL_FACILITY_ID, fileStamp,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

const empty = (v) => v === null || v === undefined || v === "";

// TWO COUNTERS, NEVER SUMMED.
//   blocking — LOSSLESSNESS and SAFETY. Non-zero => the $unset would destroy
//              information or leave unreviewed privilege. Hard stop.
//   coverage — D-1 ROLLOUT HEALTH. Reported under its own heading, feeds
//              go/no-go item E2, judged by a human. A missing baseline is
//              repairable and self-repairing (I-8b: ensureBaseline tops it up
//              at the offender's next session read); a containment failure is
//              made PERMANENT by the $unset. They answer different questions.
const blocking = [];
const coverage = [];

/** B1 / B2 / W1. */
function auditContainment({ label, docs, key, arrayKey, scalarKey }) {
  const warnings = [];
  let withScalar = 0;
  for (const d of docs) {
    const arr = Array.isArray(d[arrayKey]) ? d[arrayKey] : null;

    // B1: the array must EXIST and be an array on EVERY document. A missing
    //     array means the Phase-1 backfill did not cover this document, so the
    //     scalar is the ONLY role data it has and dropping it destroys it.
    //     B1 is also the precondition that proves no legacy-only admin remains,
    //     which is why cutover step 3 (narrowing the last-admin guard) comes
    //     AFTER a passing gate run, not before.
    if (arr === null) { blocking.push(`${label} ${d[key]}: ${arrayKey} missing or not an array`); continue; }

    const scalar = d[scalarKey];
    if (empty(scalar)) continue;
    withScalar++;

    // B2: CONTAINMENT. This is the gate.
    if (!arr.includes(scalar)) {
      blocking.push(`${label} ${d[key]}: ${scalarKey}=${JSON.stringify(scalar)} NOT in ${arrayKey}=${JSON.stringify(arr)}`);
      continue;
    }

    // W1: warn-only equality with the dual-write rule. A stale-but-contained
    //     scalar is still lossless to delete; this flags a dual-write
    //     regression without blocking on it.
    if (arrayKey === "roles" && scalar !== legacyMirrorOrNull(arr)) {
      warnings.push(`${label} ${d[key]}: ${scalarKey}=${scalar} but legacyMirror=${legacyMirrorOrNull(arr)} (dual-write drift)`);
    }
  }
  console.log(`\n--- ${label} containment ---`);
  console.log(`documents:              ${docs.length}`);
  console.log(`carrying legacy scalar: ${withScalar}`);
  console.log(`warnings:               ${warnings.length}`);
  for (const w of warnings) console.warn(`  warn   ${w}`);
}

async function main() {
  console.log(`\n=== verify-legacy-drop.mjs (READ-ONLY GATE) ===  ${new Date().toISOString()}`);
  console.log(`RUN THIS WHILE THE DUAL-WRITE IS STILL DEPLOYED (before cutover step 5c).`);

  const userRole = await findAll(db, "UserRole");
  const facilityAccess = (await findAll(db, "FacilityAccess")).map((d) => ({ ...d, facilityID: numify(d.facilityID) }));

  auditContainment({ label: "UserRole", docs: userRole, key: "userID", arrayKey: "roles", scalarKey: "role" });
  auditContainment({ label: "FacilityAccess", docs: facilityAccess, key: "facilityID", arrayKey: "requiredRoles", scalarKey: "requiredRole" });

  // --- B2b: the resident-mirror trap (doc 06 §0.1) -----------------------
  for (const f of facilityAccess.filter((f) => f.requiredRole === "resident")) {
    blocking.push(`FacilityAccess ${f.facilityID}: requiredRole="resident" — a Phase-2 revert would ` +
      `DENY this room to EVERY non-admin (reverted access.ts reads the scalar and is default-open, ` +
      `so a truthy "resident" there gates instead of opening). Unset it: doc 06 §5 step 1, or run ` +
      `clear-resident-mirror.mjs --commit.`);
  }

  // --- B5: duplicate keys ------------------------------------------------
  // @unique is only enforced if the index actually BUILT, and this repo has a
  // live history of dual-identity duplicate accounts (merge-accounts.mjs,
  // dedupe-users.mjs, 568c51c/fe9afe8). With duplicates, findUnique returns one
  // arbitrarily, containment passes on whichever copies happen to be
  // consistent, and a divergent second copy is never reviewed.
  for (const [coll, k] of [["UserRole", "userID"], ["FacilityAccess", "facilityID"]]) {
    const r = await raw({
      aggregate: coll, cursor: {},
      pipeline: [{ $group: { _id: `$${k}`, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }],
    });
    for (const d of r?.cursor?.firstBatch ?? []) {
      blocking.push(`${coll}: duplicate ${k}=${JSON.stringify(d._id)} (${numify(d.n)} rows) — the @unique index did not build`);
    }
  }

  // --- B6: unexercised deferred privilege -------------------------------
  // PendingRoleGrant is a THIRD repository of privilege that survives the
  // cutover. An outstanding deferred admin/jcrc/scrc grant redeemed AFTER the
  // drop is a privilege change nobody at the go/no-go gate ever saw.
  //
  // "scrc" (hall office) is in this list because it is a PRIVILEGED grantable
  // role like the other two, not a baseline: it carries the power to appoint
  // the JCRC. Leaving it out would let an outstanding hall-office grant sail
  // through the gate unseen, which is the exact failure this check exists to
  // prevent — and this list is the one that BLOCKS, so an omission here is
  // silent. Any future addition to GRANTABLE_ROLES must be added here too.
  // `cca_head` is deliberately absent: it is in no ASSIGNABLE_BY entry, so it
  // cannot travel the deferred path at all.
  let pending = [];
  try { pending = await findAll(db, "PendingRoleGrant"); } catch { /* may not exist yet */ }
  const nowMs = Date.now();
  const livePriv = pending.filter((p) =>
    (p.roles ?? []).some((r) => r === "admin" || r === "jcrc" || r === "scrc") &&
    (!p.expiresAt || new Date(p.expiresAt?.$date ?? p.expiresAt).getTime() > nowMs));
  for (const p of livePriv) {
    blocking.push(`PendingRoleGrant ${p.userID}: outstanding ${JSON.stringify(p.roles)} created by ` +
      `${p.createdBy} — requires named sign-off or revocation before the drop`);
  }
  console.log(`\n--- deferred grants ---`);
  console.log(`PendingRoleGrant rows:  ${pending.length}`);
  console.log(`live admin/jcrc grants: ${livePriv.length}`);

  // --- C1 (coverage): every facility has an access row -------------------
  const facilities = (await findAll(db, "Facilities", { facilityID: 1, facilityName: 1 }))
    .map((f) => ({ ...f, facilityID: numify(f.facilityID) }));
  const gated = new Set(facilityAccess.map((f) => f.facilityID));
  const unconfigured = facilities.filter((f) => f.facilityID !== SENTINEL_FACILITY_ID && !gated.has(f.facilityID));
  console.log(`\n--- C1 facility coverage ---`);
  console.log(`Facilities (excl. -1 sentinel): ${facilities.filter((f) => f.facilityID !== SENTINEL_FACILITY_ID).length}`);
  console.log(`without a FacilityAccess row:   ${unconfigured.length}`);
  for (const f of unconfigured) {
    coverage.push(`facilityID ${f.facilityID} (${f.facilityName}) has NO FacilityAccess row`);
    console.warn(`  COVERAGE  facilityID ${f.facilityID} (${f.facilityName})`);
  }

  // --- C2 (coverage): stored-baseline coverage ---------------------------
  // Under the revised I-8 `resident` is STORED, so this counts real rows, not a
  // materialization lag. DORMANCY IS NO LONGER AN EXCUSE for a non-zero C2: the
  // backfill is authoritative and grants the baseline to every eligible User
  // row whether or not it has ever signed in. A non-zero C2 means the backfill
  // missed someone or a creation-time grant point (I-8a) is broken — a real
  // signal, which is why go/no-go item E2 demands three consecutive clean runs.
  //
  // Population is restricted to accounts the auto-grant can actually REACH: an
  // anchored @u.nus.edu email, deduplicated by canonical id. Non-NUS rows can
  // never hold resident by design (D-7 / I-8d) and are reported separately —
  // counting them would make this permanently non-zero and therefore ignored.
  //
  // Same predicate as backfill-resident.mjs and rbac-doctor.mjs (I-12), and
  // none of the three may test /^E\d{7}$/ (L-27: G.S_SAMUEL is a real id).
  const users = await findAll(db, "User", { email: 1 });
  const eligible = new Set();
  let nonNus = 0, blankEmail = 0, collapsed = 0;
  for (const u of users) {
    const id = canonicalUserID(u.email);
    if (!isCanonicalResidentID(id)) { if (String(u.email ?? "").trim()) nonNus++; else blankEmail++; continue; }
    if (eligible.has(id)) collapsed++;
    eligible.add(id);
  }
  const withResident = new Set(userRole.filter((r) => Array.isArray(r.roles) && r.roles.includes("resident")).map((r) => r.userID));
  const missing = [...eligible].filter((id) => !withResident.has(id));
  const unbacked = [...withResident].filter((id) => !eligible.has(id));

  console.log(`\n--- C2 resident coverage ---`);
  console.log(`User documents:                  ${users.length}`);
  console.log(`  non-NUS (cannot sign in, D-7): ${nonNus}   [informational]`);
  console.log(`  blank email:                   ${blankEmail} [informational]`);
  console.log(`  duplicate canonical ids:       ${collapsed} [informational]`);
  console.log(`ELIGIBLE (distinct canonical):   ${eligible.size}`);
  console.log(`holding "resident":              ${withResident.size}`);
  console.log(`  MISSING resident:              ${missing.length}`);
  console.log(`  resident with NO NUS account:  ${unbacked.length}`);
  if (missing.length) {
    coverage.push(`${missing.length} eligible users missing resident`);
    console.warn(`  first 20 missing: ${missing.slice(0, 20).join(", ")}`);
  }
  // The inverse IS blocking: a resident row under an id no session can produce
  // is a mis-keyed write, and mis-keyed writes are not self-healing.
  if (unbacked.length) {
    blocking.push(`${unbacked.length} userID(s) hold "resident" with no eligible @u.nus.edu account: ` +
      `${unbacked.slice(0, 10).join(", ")}`);
  }

  // --- D1 (diagnostic): role vocabulary ---------------------------------
  // roles[] lives in a collection with NO $jsonSchema validator; nothing but
  // code constrains what strings land there.
  const strays = new Set();
  for (const r of userRole) for (const s of r.roles ?? []) if (!ROLE_VOCAB.includes(s)) strays.add(s);
  console.log(`\n--- D1 role vocabulary ---`);
  console.log(`out-of-vocabulary role strings: ${strays.size} ${strays.size ? JSON.stringify([...strays]) : ""}`);
  if (strays.size) blocking.push(`out-of-vocabulary role strings present: ${JSON.stringify([...strays])}`);

  // --- E4 (diagnostic) ---------------------------------------------------
  console.log(`\n--- E4 non-admin resident booking ---`);
  console.log(`Run the doc 06 §3.1 query by hand and paste a real userID into the go/no-go`);
  console.log(`checklist. A checkbox is not evidence; an id that actually booked is.`);

  // --- verdict -----------------------------------------------------------
  console.log(`\n================================`);
  console.log(`BLOCKING failures: ${blocking.length}`);
  for (const b of blocking) console.error(`  BLOCK     ${b}`);
  console.log(`COVERAGE issues:   ${coverage.length}  (feeds go/no-go item E2, NOT a hard block)`);
  for (const c of coverage) console.warn(`  COVERAGE  ${c}`);

  if (blocking.length) {
    console.error(`\nGATE FAILED — DO NOT DROP.`);
    process.exitCode = 1;
    return;
  }

  const marker = {
    at: new Date().toISOString(),
    counts: {
      userRole: userRole.length,
      facilityAccess: facilityAccess.length,
      userRoleWithScalar: await countWhere(db, "UserRole", { role: { $exists: true } }),
      facilityAccessWithScalar: await countWhere(db, "FacilityAccess", { requiredRole: { $exists: true } }),
    },
    coverage: coverage.length,
  };
  mkdirSync(join(HERE, "backups"), { recursive: true });
  const p = join(HERE, "backups", `gate-pass-${fileStamp()}.json`);
  writeFileSync(p, JSON.stringify(marker, null, 2));
  console.log(`\nGATE PASSED — the legacy drop is permitted.`);
  console.log(`Pass-marker: ${p}`);
  if (coverage.length) console.warn(`NOTE: ${coverage.length} coverage issue(s) — review before the go/no-go checklist.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
