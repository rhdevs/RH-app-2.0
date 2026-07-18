/**
 * Doc 06 §5 step 1: unset any FacilityAccess.requiredRole === "resident".
 *
 *   node scripts/remediation/clear-resident-mirror.mjs            # dry run
 *   node scripts/remediation/clear-resident-mirror.mjs --commit   # apply
 *
 * RUN THIS AT THE START OF THE CUTOVER WINDOW, not at the end, so the fix has
 * soaked before the one-way door.
 *
 * WHY. "resident" must NEVER be written to a legacy scalar (doc 06 §0.1). The
 * only consumer of FacilityAccess.requiredRole is the pre-v2 access.ts, which
 * is DEFAULT-OPEN: `if (!required) return true`. A truthy "resident" sitting
 * there therefore does the opposite of what it reads like — on a Phase-2 revert
 * that room becomes DENIED to every non-admin, because reverted access.ts
 * compares the scalar against a role vocabulary that has no "resident" in it.
 *
 * Also fix the WRITER, or this sweep is undone by the next dashboard edit:
 * 02-backend-authz.md:903-904 must use legacyMirror(requiredRoles), NOT
 * requiredRoles[0]. This script reports whether that is still happening.
 */
import { PrismaClient } from "@prisma/client";
import { findAll, numify, inspectWriteReply, isCommit, banner, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();
const raw = (cmd) => db.$runCommandRaw(cmd);

async function offenders() {
  return (await findAll(db, "FacilityAccess", { facilityID: 1, requiredRole: 1, requiredRoles: 1 }))
    .map((d) => ({ ...d, facilityID: numify(d.facilityID) }))
    .filter((d) => d.requiredRole === "resident");
}

async function main() {
  banner("clear-resident-mirror.mjs", COMMIT);

  const before = await offenders();
  console.log(`FacilityAccess rows with requiredRole="resident": ${before.length}`);
  for (const d of before) {
    console.log(`  ${COMMIT ? "+" : "~"} facility ${d.facilityID}: $unset requiredRole ` +
      `(requiredRoles stays ${JSON.stringify(d.requiredRoles ?? null)} — untouched)`);
  }

  if (!before.length) {
    console.log(`\nNothing to do.`);
    return;
  }
  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    return;
  }

  const reply = await raw({
    update: "FacilityAccess",
    ordered: false,
    updates: [{ q: { requiredRole: "resident" }, u: { $unset: { requiredRole: "" } }, multi: true }],
  });
  const r = inspectWriteReply(reply, "clear resident mirror");
  console.log(`\nnModified: ${r.nModified}   writeErrors: ${r.writeErrors.length}`);
  if (r.writeErrors.length) console.error(`  ${JSON.stringify(r.writeErrors)}`);

  const after = await offenders();
  console.log(`\n=== VERIFY ===`);
  console.log(`rows still carrying requiredRole="resident": ${after.length}` +
    (after.length ? ` — ${after.map((d) => d.facilityID).join(", ")}` : ""));
  if (after.length || r.writeErrors.length) {
    return abort(`sweep INCOMPLETE. If the count is stable but non-zero, a deployed writer is ` +
      `re-creating it — fix setFacilityAccess to use legacyMirror() before re-running.`);
  }
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
