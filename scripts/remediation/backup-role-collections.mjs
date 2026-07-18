/**
 * D-6: full JSON snapshot taken IMMEDIATELY BEFORE the $unset.
 *
 *   node scripts/remediation/backup-role-collections.mjs
 *
 * READ-ONLY against the database. Writes backups/pre-legacy-drop-<ISO>.json.
 *
 * WHY A NEW SNAPSHOT AND NOT THE PHASE-1 ONE. roles-v2-pre-backfill.json is
 * taken BEFORE the Phase-1 backfill — far too early to restore a
 * post-migration state, and it predates every dashboard role edit made during
 * the entire dual-write window.
 *
 * BACKS UP FOUR COLLECTIONS, NOT TWO. RoleAuditLog especially: doc 06 §6's
 * stated worst-case recovery is "manual reconstruction of the role graph from
 * RoleAuditLog", and that log is in no other backup.
 *
 * JSON rather than mongodump because it matches the existing convention
 * (merge-accounts.mjs), needs no MongoDB Database Tools install, and works from
 * the Windows dev machine where mongodump is very likely absent.
 *
 * FRESHNESS IS ENFORCED DOWNSTREAM: drop-legacy-role-fields.mjs refuses to run
 * against a snapshot older than 2 hours, because a stale snapshot misses every
 * dashboard edit since it was taken and it is the SOLE input to
 * restore-legacy-scalars.mjs.
 *
 * TAKE AN ATLAS SNAPSHOT TOO if the cluster tier supports it. M0/M2/M5
 * shared-tier clusters have NO on-demand snapshot capability at all — in that
 * case this file is the SOLE backup and the restore script is the actual
 * recovery plan, not insurance. Determine the tier BEFORE the maintenance
 * window, not during it.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findAll, fileStamp, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const HERE = dirname(fileURLToPath(import.meta.url));

const COLLECTIONS = ["UserRole", "FacilityAccess", "RoleAuditLog", "PendingRoleGrant"];

async function main() {
  console.log(`\n=== backup-role-collections.mjs (READ-ONLY) ===  ${new Date().toISOString()}\n`);

  const data = {};
  for (const c of COLLECTIONS) {
    try {
      data[c] = await findAll(db, c);
      console.log(`  ${c.padEnd(18)} ${data[c].length} row(s)`);
    } catch (e) {
      data[c] = null;
      console.warn(`  ${c.padEnd(18)} ABSENT (${e.message})`);
    }
  }

  // A snapshot missing UserRole or FacilityAccess is not a backup of anything
  // the drop touches — refuse rather than write a file that looks valid.
  for (const required of ["UserRole", "FacilityAccess"]) {
    if (data[required] === null) return abort(`${required} could not be read. Refusing to write a snapshot that cannot restore the drop.`);
  }

  const withLegacyScalar = {
    UserRole: (data.UserRole ?? []).filter((d) => d.role).length,
    FacilityAccess: (data.FacilityAccess ?? []).filter((d) => d.requiredRole).length,
  };

  mkdirSync(join(HERE, "backups"), { recursive: true });
  const path = join(HERE, "backups", `pre-legacy-drop-${fileStamp()}.json`);
  writeFileSync(path, JSON.stringify({
    at: new Date().toISOString(),
    note: "D-6 pre-$unset snapshot. FORENSICS ONLY on restore — restore-legacy-scalars.mjs " +
      "reconstructs the scalar from the LIVE roles[] array (rule R1), never from this file, " +
      "because copying a snapshot scalar would re-grant roles revoked since it was taken.",
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v?.length ?? "ABSENT"])),
    withLegacyScalar,
    ...data,
  }, null, 2));

  // These printed counts are LOAD-BEARING: they are what cutover step 6 must
  // show as having gone to zero, and what a restore must put back.
  console.log(`\n=== RECORD THESE IN THE GO/NO-GO CHECKLIST ===`);
  console.log(`UserRole:                    ${data.UserRole?.length ?? "ABSENT"}`);
  console.log(`FacilityAccess:              ${data.FacilityAccess?.length ?? "ABSENT"}`);
  console.log(`RoleAuditLog:                ${data.RoleAuditLog?.length ?? "ABSENT"}`);
  console.log(`PendingRoleGrant:            ${data.PendingRoleGrant?.length ?? "ABSENT"}`);
  console.log(`UserRole with legacy role:   ${withLegacyScalar.UserRole}`);
  console.log(`FacilityAccess with legacy:  ${withLegacyScalar.FacilityAccess}`);
  console.log(`\nSnapshot: ${path}`);
  console.log(`(contains the full role graph — backups/ MUST stay gitignored)`);
  console.log(`\nThe drop script accepts this snapshot for 2 HOURS. If you slip past that,`);
  console.log(`re-run this script rather than forcing the drop.`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
