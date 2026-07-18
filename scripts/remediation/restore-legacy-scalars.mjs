/**
 * D-6 RESTORE: re-create the legacy `role` / `requiredRole` scalars so a
 * Phase-2 code revert has a valid mirror to read.
 *
 *   node scripts/remediation/restore-legacy-scalars.mjs                      # dry run
 *   node scripts/remediation/restore-legacy-scalars.mjs --commit             # apply
 *   node scripts/remediation/restore-legacy-scalars.mjs --forensics <file>   # diff only, never writes
 *
 * RULE R1 — THE SCALAR IS RECONSTRUCTED FROM THE LIVE roles[] ARRAY, NEVER
 * COPIED FROM A SNAPSHOT. A naive restore ($set role from snapshot.role, keyed
 * by userID) RE-GRANTS PRIVILEGES THAT WERE LEGITIMATELY REVOKED after the
 * snapshot: a user is admin at snapshot time; weeks later an admin demotes them
 * (roles -> ["jcrc"], no scalar because the dual-write is gone); an incident
 * triggers the revert; the naive restore writes role:"admin" back; reverted
 * access.ts:19 reads the scalar as the source of truth and grants full admin.
 * The recovery procedure would itself be a privilege-escalation vector — and it
 * is the procedure a stressed operator runs under time pressure.
 *
 * The live roles[] array is by definition current and correct; the containment
 * gate already proved it is authoritative. So: role = legacyMirror(liveRoles).
 * The snapshot is retained for FORENSICS ONLY, via --forensics, which never
 * writes.
 *
 * RULE R2 — A PHASE-2 REVERT MUST KEEP THE SCALARS NULLABLE. A `git revert` of
 * the Phase-2 range restores the pre-v2 schema where `role` and `requiredRole`
 * are REQUIRED. After the resident backfill there are ~504 resident-only
 * UserRole documents that never had a `role` and that R1 correctly leaves
 * without one (legacyMirror(["resident"]) is null). Prisma 6 then throws on
 * every read of those documents (I-2), and getUserRole is reached from
 * facilitiesBooking.ts:130, :319 and :383 — EVERY BOOKING READ THROWS FOR EVERY
 * USER. NEVER `git checkout <pre-v2> -- prisma/schema.prisma`. Hand-edit both
 * models back to `String?` and `npx prisma db push` BEFORE running this. The
 * script asserts it below and refuses otherwise.
 *
 * This script touches ONLY the two scalar fields. It NEVER writes roles[] /
 * requiredRoles[] — those are the source of truth, and under the revised I-8
 * they hold the ~515 stored resident baselines, which survive a revert
 * untouched and inert. Preserving them is done by doing nothing.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { findAll, numify, inspectWriteReply, isCommit, banner, abort, legacyMirrorOrNull } from "./lib/rbac.mjs";

const db = new PrismaClient();
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

const COMMIT = isCommit();
const fIdx = process.argv.indexOf("--forensics");
const FORENSICS = fIdx >= 0 ? process.argv[fIdx + 1] : null;

/** Scripts are invoked from the repo root, so resolve against cwd first and
 *  fall back to the script directory. PRINT the resolved absolute path — a
 *  restore that cannot find its input is an availability failure at exactly
 *  the worst moment. */
function resolveInput(p) {
  const candidates = isAbsolute(p) ? [p] : [resolve(process.cwd(), p), join(HERE, p), join(HERE, "backups", p)];
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error(`snapshot not found. Tried:\n  ${candidates.join("\n  ")}`);
  console.log(`resolved snapshot: ${hit}`);
  return hit;
}

async function forensics(path) {
  const snap = JSON.parse(readFileSync(resolveInput(path), "utf8"));
  console.log(`\n=== FORENSICS (READ-ONLY — this mode NEVER writes) ===`);
  console.log(`snapshot taken: ${snap.at}`);

  const liveUR = new Map((await findAll(db, "UserRole", { userID: 1, roles: 1, role: 1 })).map((d) => [d.userID, d]));
  console.log(`\n--- UserRole: snapshot scalar vs. TODAY's live roles[] ---`);
  let diverged = 0;
  for (const s of snap.UserRole ?? []) {
    const live = liveUR.get(s.userID);
    const rebuilt = legacyMirrorOrNull(live?.roles);
    if ((s.role || null) === rebuilt) continue;
    diverged++;
    console.log(`  ${s.userID}: snapshot role=${JSON.stringify(s.role ?? null)}  ` +
      `live roles=${JSON.stringify(live?.roles ?? null)}  -> would restore ${JSON.stringify(rebuilt)}`);
  }
  console.log(`\ndiverged since the snapshot: ${diverged}`);
  console.log(`Every line above is a role change made AFTER the snapshot. Restoring from the`);
  console.log(`snapshot instead of from live roles[] would UNDO each one — which for a demotion`);
  console.log(`means re-granting privilege. That is why R1 exists.`);
}

async function main() {
  if (FORENSICS) { await forensics(FORENSICS); return; }

  banner("restore-legacy-scalars.mjs", COMMIT);

  // --- R2 assertion ------------------------------------------------------
  const schemaPath = resolve(process.cwd(), "prisma/schema.prisma");
  if (!existsSync(schemaPath)) {
    return abort(`cannot find ${schemaPath}. Run this from the repo root.`);
  }
  const schema = readFileSync(schemaPath, "utf8");
  if (!/^\s+role\s+String\?/m.test(schema) || !/^\s+requiredRole\s+String\?/m.test(schema)) {
    return abort(`RULE R2: prisma/schema.prisma must declare \`role String?\` AND ` +
      `\`requiredRole String?\`, and \`npx prisma db push\` must have been run, BEFORE restoring. ` +
      `Required scalars + the ~504 resident-only documents = Prisma throws on EVERY role read ` +
      `(I-2), and getUserRole is on the booking path. Hand-edit both models to String? — do NOT ` +
      `git checkout the pre-v2 schema.`);
  }
  console.log(`R2  schema declares both scalars optional: OK`);

  // --- UserRole ----------------------------------------------------------
  const userRole = await findAll(db, "UserRole", { userID: 1, roles: 1, role: 1 });
  const urPlan = [];
  for (const d of userRole) {
    const mirror = legacyMirrorOrNull(d.roles);
    if (!mirror) continue;                 // resident-only: correctly NO scalar (doc 06 §0.1)
    if (d.role === mirror) continue;
    urPlan.push({ userID: d.userID, from: d.role ?? null, to: mirror, roles: d.roles });
  }

  // --- FacilityAccess ----------------------------------------------------
  const facilityAccess = (await findAll(db, "FacilityAccess", { facilityID: 1, requiredRoles: 1, requiredRole: 1 }))
    .map((d) => ({ ...d, facilityID: numify(d.facilityID) }));
  const faPlan = [];
  for (const d of facilityAccess) {
    const mirror = legacyMirrorOrNull(d.requiredRoles);
    if (!mirror) continue;                 // resident-only -> no scalar (doc 06 §0.1)
    if (d.requiredRole === mirror) continue;
    faPlan.push({ facilityID: d.facilityID, from: d.requiredRole ?? null, to: mirror });
  }

  console.log(`\n--- PLAN (reconstructed from LIVE arrays, rule R1) ---`);
  console.log(`UserRole rows to restore:       ${urPlan.length} of ${userRole.length}`);
  for (const p of urPlan) console.log(`  ${COMMIT ? "+" : "~"} UserRole ${p.userID}: role ${JSON.stringify(p.from)} -> ${JSON.stringify(p.to)}  (live roles=${JSON.stringify(p.roles)})`);
  console.log(`FacilityAccess rows to restore: ${faPlan.length} of ${facilityAccess.length}`);
  for (const p of faPlan) console.log(`  ${COMMIT ? "+" : "~"} FacilityAccess ${p.facilityID}: requiredRole ${JSON.stringify(p.from)} -> ${JSON.stringify(p.to)}`);
  // Rows whose legacyMirror is null are resident-only. They correctly end up
  // with NO scalar, which under a reverted, default-open access.ts
  // (`if (!required) return true`) is exactly right.
  console.log(`\nDeliberately left with NO scalar (resident-only, doc 06 §0.1):`);
  console.log(`  UserRole rows:       ${userRole.filter((d) => !legacyMirrorOrNull(d.roles)).length}`);
  console.log(`  FacilityAccess rows: ${facilityAccess.filter((d) => !legacyMirrorOrNull(d.requiredRoles)).length}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    console.log(`NOTE: restoring the mirror is only coherent as part of reverting D-1 default-deny`);
    console.log(`in the SAME commit. Do not attempt a partial revert (doc 06 §6.3).`);
    return;
  }

  console.log(`\n--- APPLYING ---`);
  const writeErrors = [];
  for (const p of urPlan) {
    const r = inspectWriteReply(await raw({
      update: "UserRole", ordered: false,
      updates: [{ q: { userID: p.userID }, u: { $set: { role: p.to } } }],
    }), `UserRole ${p.userID}`);
    if (r.writeErrors.length) writeErrors.push(r);
  }
  for (const p of faPlan) {
    const r = inspectWriteReply(await raw({
      update: "FacilityAccess", ordered: false,
      updates: [{ q: { facilityID: p.facilityID }, u: { $set: { requiredRole: p.to } } }],
    }), `FacilityAccess ${p.facilityID}`);
    if (r.writeErrors.length) writeErrors.push(r);
  }

  // --- VERIFY: re-read and confirm every mirror now matches the live array
  console.log(`\n=== VERIFY ===`);
  const urAfter = await findAll(db, "UserRole", { userID: 1, roles: 1, role: 1 });
  const faAfter = (await findAll(db, "FacilityAccess", { facilityID: 1, requiredRoles: 1, requiredRole: 1 }))
    .map((d) => ({ ...d, facilityID: numify(d.facilityID) }));
  const urBad = urAfter.filter((d) => { const m = legacyMirrorOrNull(d.roles); return m && d.role !== m; }).map((d) => d.userID);
  const faBad = faAfter.filter((d) => { const m = legacyMirrorOrNull(d.requiredRoles); return m && d.requiredRole !== m; }).map((d) => d.facilityID);
  console.log(`UserRole rows whose mirror still mismatches:       ${urBad.length}${urBad.length ? ` — ${urBad.join(", ")}` : ""}`);
  console.log(`FacilityAccess rows whose mirror still mismatches: ${faBad.length}${faBad.length ? ` — ${faBad.join(", ")}` : ""}`);
  console.log(`writeErrors: ${writeErrors.length}`);
  for (const e of writeErrors) console.error(`  WRITE ERROR ${e.label}: ${JSON.stringify(e.writeErrors)}`);
  if (urBad.length || faBad.length || writeErrors.length) {
    return abort(`restore INCOMPLETE. Re-run to resume — it is idempotent.`);
  }
  console.log(`\nMirror restored from the live arrays. roles[] / requiredRoles[] were NOT touched.`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
