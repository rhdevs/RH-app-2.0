/**
 * RBAC health check. READ-ONLY, safe to run at any time, exits 1 on any RED
 * line. Run it DAILY through the rollout.
 *
 *   node scripts/remediation/rbac-doctor.mjs
 *   node scripts/remediation/rbac-doctor.mjs --names   # print every offending id
 *
 * This is the detection query that is otherwise missing everywhere. It is also
 * surfaced as an /admin health panel (03-admin-dashboard.md) with per-user
 * identifier lists for admin only and aggregate counts for jcrc.
 *
 * WHICH LINES GATE WHAT:
 *   Phase 2 DEPLOY is gated by     — the two "missing legacy" lines and
 *                                    "orphans under the OLD key".
 *   The enforcement FLIP past off  — "eligible users MISSING resident",
 *                                    "UNCONFIGURED", "shadow denials, last 24h".
 *
 * By default every RED line prints up to 20 offending identifiers; --names
 * prints all of them. A bare count is not actionable (I-16).
 *
 * "eligible users MISSING it" is computed over User rows whose email matches
 * the anchored NUS regex ONLY. Counting non-NUS rows there would make it a line
 * that can NEVER reach zero, and a gate that can never reach zero gets
 * commented out — which deletes the detector.
 */
import { PrismaClient } from "@prisma/client";
import { canonicalUserID, isCanonicalResidentID } from "./lib/identity.mjs";
import {
  findAll, countWhere, numify, E_FORMAT, ROLE_VOCAB, SENTINEL_FACILITY_ID, legacyCanonicalUserID,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const ALL_NAMES = process.argv.includes("--names");
const raw = (cmd) => db.$runCommandRaw(cmd);

const red = [];
const W = 46;

/** One report line. `bad` non-empty makes it RED and records the offenders. */
function line(label, value, { bad = null, note = "", info = false } = {}) {
  const isRed = Array.isArray(bad) ? bad.length > 0 : !!bad;
  const tag = isRed ? "  <- RED" : info ? "  [informational]" : "";
  console.log(`${label.padEnd(W, ".")} ${String(value).padStart(5)}${tag}${note ? `  ${note}` : ""}`);
  if (isRed) {
    const list = Array.isArray(bad) ? bad : [];
    red.push({ label, value, offenders: list });
    if (list.length) {
      const shown = ALL_NAMES ? list : list.slice(0, 20);
      console.error(`      ${shown.join(", ")}${!ALL_NAMES && list.length > 20 ? `  … (+${list.length - 20} more; --names for all)` : ""}`);
    }
  }
}

async function main() {
  console.log(`\n=== rbac-doctor.mjs ===  ${new Date().toISOString()}\n`);

  const users = await findAll(db, "User", { _id: 1, email: 1 });
  const userRole = await findAll(db, "UserRole", { userID: 1, roles: 1, role: 1 });
  const facilities = (await findAll(db, "Facilities", { facilityID: 1, facilityName: 1 }))
    .map((f) => ({ ...f, facilityID: numify(f.facilityID) }));
  const access = (await findAll(db, "FacilityAccess", { facilityID: 1, requiredRoles: 1, requiredRole: 1 }))
    .map((a) => ({ ...a, facilityID: numify(a.facilityID) }));

  // --- population -------------------------------------------------------
  const eligible = new Map();
  const nonNus = [], blank = [], nonE = [], collisions = [];
  for (const u of users) {
    const e = String(u.email ?? "");
    const id = canonicalUserID(e);
    if (!isCanonicalResidentID(id)) { (e.trim() ? nonNus : blank).push(e || String(u._id?.$oid ?? u._id)); continue; }
    if (!E_FORMAT.test(id)) nonE.push(id);
    if (eligible.has(id)) collisions.push(id);
    else eligible.set(id, e);
  }

  line("users(total)", users.length);
  line("users(eligible, canonical has no @)", eligible.size);
  line("users(INELIGIBLE — cannot sign in under D-7)", nonNus.length, { info: true, note: "migration list" });
  if (nonNus.length) console.log(`      ${(ALL_NAMES ? nonNus : nonNus.slice(0, 20)).join(", ")}`);
  line("canonical id collisions", collisions.length, { bad: collisions, note: "merged accounts" });
  line("canonical id empty (blank email)", blank.length, { bad: blank });
  line("canonical id not E-format", nonE.length, { info: true, note: "LEGITIMATE — never exclude (L-27)" });

  // --- stored baseline (the flip gate) ----------------------------------
  const withResident = new Set(userRole.filter((r) => (r.roles ?? []).includes("resident")).map((r) => r.userID));
  const missingResident = [...eligible.keys()].filter((id) => !withResident.has(id));
  // Inverse: a stored resident under an id with no eligible NUS account behind
  // it. That is a mis-keyed grant — the row exists but no session matches it.
  const unbackedResident = [...withResident].filter((id) => !eligible.has(id));

  line("UserRole rows with stored resident", withResident.size);
  line("  eligible users MISSING it", missingResident.length, {
    bad: missingResident, note: "live lockout list; BLOCKS the flip past off" });
  line("  resident held with NO eligible account", unbackedResident.length, { bad: unbackedResident });

  // --- shape invariants (the deploy gate) -------------------------------
  const noArr = userRole.filter((r) => !Array.isArray(r.roles)).map((r) => r.userID);
  const noLeg = userRole.filter((r) => r.role === undefined).map((r) => r.userID);
  const nonCanonical = userRole.filter((r) => !isCanonicalResidentID(String(r.userID ?? ""))).map((r) => r.userID);
  const dupCounts = new Map();
  for (const r of userRole) dupCounts.set(r.userID, (dupCounts.get(r.userID) ?? 0) + 1);
  const dupUR = [...dupCounts].filter(([, n]) => n > 1).map(([id, n]) => `${id}(x${n})`);
  const strays = [...new Set(userRole.flatMap((r) => (r.roles ?? []).filter((s) => !ROLE_VOCAB.includes(s))))];

  line("UserRole rows missing roles[]", noArr.length, { bad: noArr });
  line("UserRole rows missing legacy 'role'", noLeg.length, { bad: noLeg, note: "I-2; BLOCKS the Phase 2 deploy" });
  line("UserRole keyed on a non-canonical id", nonCanonical.length, { bad: nonCanonical, note: "I-1" });
  line("UserRole duplicate userID rows", dupUR.length, { bad: dupUR, note: "did the @unique index build?" });
  line("out-of-vocabulary role strings", strays.length, { bad: strays, note: "no $jsonSchema guards roles[]" });

  const missingHash = await countWhere(db, "User", { passwordHash: { $exists: false } });
  line("User rows missing passwordHash", missingHash, {
    bad: missingHash ? ["(count only — see inventory-rbac.mjs)"] : null,
    note: "needs passwordHash String? in schema" });

  // --- orphans under the OLD key (doc 01 Step 4) ------------------------
  let orphanGroups = [];
  for (const u of users) {
    const oldKey = legacyCanonicalUserID(u.email);
    const newKey = canonicalUserID(u.email);
    if (oldKey === newKey || !oldKey) continue;
    for (const coll of ["Bookings", "UserCCA", "UserMatric", "UserRole"]) {
      const n = await countWhere(db, coll, { userID: oldKey });
      if (n) orphanGroups.push(`${coll}:${oldKey}(${n})`);
    }
  }
  line("orphans under the OLD key", orphanGroups.length, {
    bad: orphanGroups, note: "BLOCKS the Phase 2 deploy" });

  // --- facilities -------------------------------------------------------
  const realFacilities = facilities.filter((f) => f.facilityID !== SENTINEL_FACILITY_ID);
  const configured = new Set(access.map((a) => a.facilityID));
  const unconfigured = realFacilities.filter((f) => !configured.has(f.facilityID))
    .map((f) => `${f.facilityID} (${f.facilityName})`);
  const storesAdmin = access.filter((a) => (a.requiredRoles ?? []).includes("admin")).map((a) => a.facilityID);
  const faNoLegacy = access.filter((a) => a.requiredRole === undefined).map((a) => a.facilityID);
  const faResidentMirror = access.filter((a) => a.requiredRole === "resident").map((a) => a.facilityID);

  line("facilities (excl. -1)", realFacilities.length);
  line("  with a FacilityAccess row", realFacilities.length - unconfigured.length);
  line("  UNCONFIGURED", unconfigured.length, { bad: unconfigured, note: "would default to resident; blocks the flip" });
  line("  storing \"admin\" in requiredRoles", storesAdmin.length, { bad: storesAdmin });
  line("FacilityAccess missing legacy scalar", faNoLegacy.length, { bad: faNoLegacy, note: "I-2" });
  line("FacilityAccess requiredRole=\"resident\"", faResidentMirror.length, {
    bad: faResidentMirror, note: "a Phase-2 revert would DENY these rooms to all non-admins (06 §0.1)" });

  // --- deferred privilege ----------------------------------------------
  let pending = [];
  try { pending = await findAll(db, "PendingRoleGrant"); } catch { /* collection may not exist yet */ }
  const nowMs = Date.now();
  const privPending = pending.filter((p) => (p.roles ?? []).some((r) => r === "admin" || r === "jcrc"));
  const expired = pending.filter((p) => p.expiresAt && new Date(p.expiresAt?.$date ?? p.expiresAt).getTime() <= nowMs);
  line("PendingRoleGrant: outstanding", pending.length);
  line("  of which admin/jcrc", privPending.length, {
    bad: privPending.map((p) => `${p.userID}:${JSON.stringify(p.roles)}`),
    note: "requires named sign-off before the legacy drop" });
  line("  expired, unclaimed", expired.length, { info: true });

  // --- enforcement + shadow denials -------------------------------------
  const flag = (await raw({ find: "SystemFlag", filter: { key: "rbac.booking.enforcement" }, limit: 1 }))
    ?.cursor?.firstBatch?.[0];
  const mode = flag?.value ?? "(no row — env floor applies, default off)";
  console.log(`${"enforcement mode".padEnd(W, ".")} ${String(mode).padStart(5)}`);

  let shadow = 0;
  try {
    shadow = await countWhere(db, "RoleAuditLog", {
      action: "booking.denied.shadow",
      at: { $gte: { $date: new Date(nowMs - 24 * 3600 * 1000).toISOString() } },
    });
  } catch { /* collection may not exist yet */ }
  line("shadow denials, last 24h", shadow, {
    // Not RED by itself — a non-zero count is the SIGNAL the permissive soak
    // exists to produce. It is a human go/no-go, not a machine gate.
    info: true, note: "go/no-go for \"enforce\"" });

  // --- verdict ----------------------------------------------------------
  console.log(`\n================================`);
  if (red.length) {
    console.error(`RED LINES: ${red.length}`);
    for (const r of red) console.error(`  RED  ${r.label.replace(/\.+$/, "")} = ${r.value}`);
    process.exitCode = 1;
    return;
  }
  console.log(`All lines green${String(mode) === "off" ? ` (enforcement mode: off, as expected pre-flip)` : ""}.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
