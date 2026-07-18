/**
 * D-6, IRREVERSIBLE: $unset the legacy `role` / `requiredRole` fields.
 *
 *   node scripts/remediation/drop-legacy-role-fields.mjs                     # dry run
 *   APPLY=yes CONFIRM=drop-legacy node scripts/remediation/drop-legacy-role-fields.mjs
 *   node scripts/remediation/drop-legacy-role-fields.mjs --commit --confirm drop-legacy
 *
 * THE DOUBLE GATE IS DELIBERATE. Both the write flag AND CONFIRM=drop-legacy
 * are required — stricter than every other script here, matching
 * dedupe-users.mjs's own precedent of a second flag for its genuinely
 * destructive branch. `db push` removes the field from PRISMA'S VIEW only; the
 * stored documents keep it until this runs, which is why this step exists at
 * all and why it is separate from 5b.
 *
 * ENFORCED PRECONDITIONS — the script REFUSES if any fails:
 *   P1. A gate-pass marker from verify-legacy-drop.mjs exists AND its recorded
 *       counts are consistent with the live counts NOW.
 *   P2. Containment (B1/B2/B2b) re-verified INLINE, right now. Cheap on ~525
 *       documents, and it is what catches a still-deployed dual-writer BEFORE
 *       the one-way door rather than after.
 *   P3. A pre-legacy-drop-*.json snapshot exists and is less than 2h old.
 *
 * $runCommandRaw does NOT throw on a per-write failure — the replies are read.
 */
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findAll, countWhere, numify, inspectWriteReply, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

const APPLY = process.env.APPLY === "yes" || process.argv.includes("--commit");
const confirmIdx = process.argv.indexOf("--confirm");
const CONFIRM = process.env.CONFIRM === "drop-legacy" || process.argv[confirmIdx + 1] === "drop-legacy";
const MAX_SNAPSHOT_AGE_MS = 2 * 60 * 60 * 1000;

async function main() {
  console.log(`\n=== drop-legacy-role-fields.mjs ===`);
  console.log(`MODE: ${APPLY && CONFIRM ? "APPLY (IRREVERSIBLE)" : "DRY RUN (no writes)"}`);
  console.log(`at:   ${new Date().toISOString()}\n`);

  let files = [];
  try { files = readdirSync(join(HERE, "backups")); }
  catch { return abort(`backups/ does not exist. Run backup-role-collections.mjs.`); }

  // --- P1: gate-pass marker ---------------------------------------------
  const markers = files.filter((f) => f.startsWith("gate-pass-") && f.endsWith(".json")).sort();
  if (!markers.length) {
    return abort(`no gate-pass-*.json. Run verify-legacy-drop.mjs — and run it WHILE THE ` +
      `DUAL-WRITE IS STILL DEPLOYED, or its containment check is meaningless.`);
  }
  const markerFile = markers.at(-1);
  const marker = JSON.parse(readFileSync(join(HERE, "backups", markerFile), "utf8"));
  console.log(`P1  gate marker: ${markerFile}  (passed ${marker.at})`);

  // --- P3: fresh snapshot ------------------------------------------------
  const snaps = files
    .filter((f) => f.startsWith("pre-legacy-drop-") && f.endsWith(".json"))
    .map((f) => ({ f, m: statSync(join(HERE, "backups", f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!snaps.length) return abort(`no pre-legacy-drop-*.json. Run backup-role-collections.mjs.`);
  const ageMin = Math.round((Date.now() - snaps[0].m) / 60000);
  console.log(`P3  snapshot:    ${snaps[0].f}  (${ageMin} min old)`);
  if (Date.now() - snaps[0].m > MAX_SNAPSHOT_AGE_MS) {
    return abort(`snapshot is ${ageMin} min old (max 120). A stale snapshot misses every ` +
      `dashboard edit since it was taken, and it is the SOLE input to restore-legacy-scalars.mjs. ` +
      `Re-run backup-role-collections.mjs.`);
  }

  // --- P2: inline containment + resident-mirror re-check -----------------
  const userRole = await findAll(db, "UserRole");
  const facilityAccess = (await findAll(db, "FacilityAccess")).map((d) => ({ ...d, facilityID: numify(d.facilityID) }));
  const bad = [];
  for (const d of userRole) {
    if (!Array.isArray(d.roles)) bad.push(`UserRole ${d.userID}: roles is not an array — the scalar is its ONLY role data`);
    else if (d.role && !d.roles.includes(d.role)) bad.push(`UserRole ${d.userID}: role=${JSON.stringify(d.role)} not in roles=${JSON.stringify(d.roles)}`);
  }
  for (const d of facilityAccess) {
    if (!Array.isArray(d.requiredRoles)) bad.push(`FacilityAccess ${d.facilityID}: requiredRoles is not an array`);
    else if (d.requiredRole === "resident") bad.push(`FacilityAccess ${d.facilityID}: requiredRole="resident" (doc 06 §0.1) — run clear-resident-mirror.mjs`);
    else if (d.requiredRole && !d.requiredRoles.includes(d.requiredRole)) bad.push(`FacilityAccess ${d.facilityID}: requiredRole=${JSON.stringify(d.requiredRole)} not in requiredRoles=${JSON.stringify(d.requiredRoles)}`);
  }
  if (bad.length) {
    for (const b of bad) console.error(`  BLOCK  ${b}`);
    return abort(`P2: ${bad.length} containment failure(s) RIGHT NOW. The $unset would destroy this data permanently.`);
  }
  console.log(`P2  containment: clean (${userRole.length} UserRole + ${facilityAccess.length} FacilityAccess)`);

  // --- counts ------------------------------------------------------------
  const beforeUR = await countWhere(db, "UserRole", { role: { $exists: true } });
  const beforeFA = await countWhere(db, "FacilityAccess", { requiredRole: { $exists: true } });
  console.log(`\nBEFORE  UserRole.role: ${beforeUR}   FacilityAccess.requiredRole: ${beforeFA}`);
  console.log(`Gate recorded: ${marker.counts.userRoleWithScalar} / ${marker.counts.facilityAccessWithScalar}`);
  if (beforeUR > marker.counts.userRoleWithScalar || beforeFA > marker.counts.facilityAccessWithScalar) {
    return abort(`live scalar count EXCEEDS the gate's recorded count — a writer is still ` +
      `dual-writing (cutover step 4 not deployed?). New documents have appeared carrying the ` +
      `field since the gate passed.`);
  }

  if (!APPLY || !CONFIRM) {
    console.log(`\nDRY RUN — nothing changed.`);
    console.log(`Would $unset role from ${beforeUR} UserRole row(s) and requiredRole from ${beforeFA} FacilityAccess row(s).`);
    console.log(`To apply: APPLY=yes CONFIRM=drop-legacy node scripts/remediation/drop-legacy-role-fields.mjs`);
    return;
  }

  // --- the one-way door --------------------------------------------------
  console.log(`\n--- APPLYING (IRREVERSIBLE) ---`);
  const r1 = inspectWriteReply(await raw({
    update: "UserRole", ordered: false,
    updates: [{ q: { role: { $exists: true } }, u: { $unset: { role: "" } }, multi: true }],
  }), "UserRole.role");
  const r2 = inspectWriteReply(await raw({
    update: "FacilityAccess", ordered: false,
    updates: [{ q: { requiredRole: { $exists: true } }, u: { $unset: { requiredRole: "" } }, multi: true }],
  }), "FacilityAccess.requiredRole");
  console.log(`  UserRole.role                nModified=${r1.nModified} writeErrors=${r1.writeErrors.length}`);
  console.log(`  FacilityAccess.requiredRole  nModified=${r2.nModified} writeErrors=${r2.writeErrors.length}`);
  for (const r of [r1, r2]) if (r.writeErrors.length) console.error(`  WRITE ERROR ${r.label}: ${JSON.stringify(r.writeErrors)}`);

  const afterUR = await countWhere(db, "UserRole", { role: { $exists: true } });
  const afterFA = await countWhere(db, "FacilityAccess", { requiredRole: { $exists: true } });
  console.log(`\nAFTER   UserRole.role: ${afterUR}   FacilityAccess.requiredRole: ${afterFA}`);
  if (afterUR || afterFA || r1.writeErrors.length || r2.writeErrors.length) {
    return abort(`INCOMPLETE — documents still carry the legacy field. A deployed writer is still ` +
      `dual-writing (cutover step 4).`);
  }

  console.log(`\nLegacy fields removed. NOT reversible without the snapshot.`);
  console.log(`\nRE-RUN THE STEP 6 COUNTS AT +24h AND +72h. A login-path writer will NOT show up`);
  console.log(`immediately: ensureBaseline's $setOnInsert fires only when a UserRole document is`);
  console.log(`newly INSERTED (a new account, or one hand-deleted and self-healed), so a surviving`);
  console.log(`writer resurrects the field days later, not now. This "0 / 0" is necessary, not`);
  console.log(`sufficient. If it reappears:`);
  console.log(`    db.UserRole.find({ role: { $exists: true } }, { userID: 1 })`);
  console.log(`names the offenders — cross-check them against recent User creations to identify`);
  console.log(`which writer survived step 4.`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
