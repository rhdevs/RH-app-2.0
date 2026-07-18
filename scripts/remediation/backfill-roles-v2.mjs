/**
 * RBAC v2 step 1: backfill the array-shaped role fields onto EXISTING documents.
 *
 * MUST run BEFORE `npx prisma db push` and BEFORE any code deploy (invariant
 * I-3: data -> schema -> code).
 *
 *   node scripts/remediation/backfill-roles-v2.mjs            # dry run (default)
 *   node scripts/remediation/backfill-roles-v2.mjs --commit   # apply
 *   APPLY=yes node scripts/remediation/backfill-roles-v2.mjs  # same thing
 *
 * Idempotent. Uses $runCommandRaw only, so it works before `prisma generate`
 * knows about the new fields and never issues a typed read that could throw on
 * a document of the old shape.
 *
 * CREATES NO DOCUMENTS. Every update is a $set on a document matched by its
 * existing key, with NO upsert. Document creation is not permitted until Step 8
 * has made the legacy scalars optional (doc 01 §0.2) — until then, a created
 * document lacking `role` is unreadable by the STILL-DEPLOYED Prisma client and
 * takes down every login.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findAll, numify, inspectWriteReply, isCommit, banner, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

async function main() {
  banner("backfill-roles-v2.mjs", COMMIT);

  const userRole = await findAll(db, "UserRole");
  const facilityAccess = await findAll(db, "FacilityAccess");

  // Snapshot FIRST. On a shared-tier Atlas cluster with no on-demand snapshot
  // capability this file is the ONLY backup of the pre-migration role graph.
  mkdirSync(join(HERE, "backups"), { recursive: true });
  const backupPath = join(HERE, "backups", "roles-v2-pre-backfill.json");
  writeFileSync(backupPath, JSON.stringify({ at: new Date().toISOString(), userRole, facilityAccess }, null, 2));
  console.log(`Backup: ${userRole.length} UserRole + ${facilityAccess.length} FacilityAccess rows -> ${backupPath}`);

  const writeErrors = [];

  // [1] Filter on the ABSENCE of `roles`, not the presence of `role`, so a
  //     document carrying NEITHER field is repaired rather than skipped.
  const needRoles = userRole.filter((d) => !Array.isArray(d.roles));
  console.log(`\n[1] UserRole.roles backfill: ${needRoles.length} row(s)`);
  for (const d of needRoles) {
    const roles = d.role ? [d.role] : [];
    console.log(`  ${COMMIT ? "+" : "~"} ${d.userID}: roles -> ${JSON.stringify(roles)}`);
    if (!COMMIT) continue;
    const r = inspectWriteReply(
      await raw({ update: "UserRole", ordered: false, updates: [{ q: { userID: d.userID }, u: { $set: { roles } } }] }),
      `UserRole ${d.userID}`);
    if (r.writeErrors.length) writeErrors.push(r);
  }

  // [2] Same for FacilityAccess.requiredRoles.
  //     The legacy `requiredRole` on existing rows is left EXACTLY as-is. The
  //     one existing row is SCRC with requiredRole:"jcrc"; preserving it is what
  //     keeps the still-deployed access.ts:36-39 enforcing today's gate for the
  //     whole of Phase 1.
  const needReq = facilityAccess.filter((d) => !Array.isArray(d.requiredRoles));
  console.log(`\n[2] FacilityAccess.requiredRoles backfill: ${needReq.length} row(s)`);
  for (const d of needReq) {
    const requiredRoles = d.requiredRole ? [d.requiredRole] : [];
    const fid = numify(d.facilityID);
    console.log(`  ${COMMIT ? "+" : "~"} facility ${fid}: -> ${JSON.stringify(requiredRoles)} ` +
      `(legacy requiredRole=${JSON.stringify(d.requiredRole ?? null)} PRESERVED)`);
    if (!COMMIT) continue;
    const r = inspectWriteReply(
      await raw({ update: "FacilityAccess", ordered: false, updates: [{ q: { facilityID: fid }, u: { $set: { requiredRoles } } }] }),
      `FacilityAccess ${fid}`);
    if (r.writeErrors.length) writeErrors.push(r);
  }

  // [3] VERIFY — re-read, and NAME the offenders (I-16). A count of what we
  //     believe we wrote can match by coincidence; a re-read cannot.
  const badUR = (await findAll(db, "UserRole")).filter((d) => !Array.isArray(d.roles));
  const badFA = (await findAll(db, "FacilityAccess")).filter((d) => !Array.isArray(d.requiredRoles));
  console.log(`\n=== VERIFY ===`);
  console.log(`UserRole missing roles[]:               ${badUR.length}` +
    (badUR.length ? ` — ${badUR.map((d) => d.userID).join(", ")}` : ""));
  console.log(`FacilityAccess missing requiredRoles[]: ${badFA.length}` +
    (badFA.length ? ` — ${badFA.map((d) => numify(d.facilityID)).join(", ")}` : ""));
  console.log(`writeErrors:                            ${writeErrors.length}`);
  for (const e of writeErrors) console.error(`  WRITE ERROR  ${e.label}: ${JSON.stringify(e.writeErrors)}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    return;
  }
  if (badUR.length || badFA.length || writeErrors.length) {
    return abort(`BACKFILL INCOMPLETE — do NOT proceed to prisma db push. Re-run to resume.`);
  }
  console.log(`\nBoth VERIFY counts are 0. Step 7 (schema edit) + Step 8 (db push) may proceed.`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
