/**
 * Grants the stored `resident` baseline on UserRole for every eligible User.
 * Iterates **User** (~515 rows), NOT UserRole (11 rows).
 *
 *   node scripts/remediation/backfill-resident.mjs             # dry run (default)
 *   node scripts/remediation/backfill-resident.mjs --commit    # apply
 *   APPLY=yes node scripts/remediation/backfill-resident.mjs   # same thing
 *   ONLY=backups/resident-backfill-missing.json node ... --commit   # resume
 *
 * MUST run AFTER Step 8 (the push that made the legacy scalars optional) — this
 * script CREATES ~504 documents.
 *
 * AUTHORITATIVE. `resident` is a STORED role (doc 01 §0.1); nothing derives it.
 * An id this run misses holds NO baseline and cannot book a normal room (the
 * D-1 default is ["resident"]) until ensureBaseline() repairs it at that user's
 * next session read (I-8b). A partial run is therefore a REAL, if self-healing,
 * lockout for the ids it missed — not a visibility gap. Three consequences that
 * shape this script:
 *   - the VERIFY pass is a SET DIFFERENCE against what is actually stored and
 *     NAMES every missing id (I-16); it exits 1 on a non-empty set;
 *   - re-running the script IS the resume — every write is $addToSet + upsert,
 *     so it is idempotent and order-independent (ordered:false);
 *   - ONLY=<file> reprocesses just the previous run's misses.
 *
 * ELIGIBILITY is isCanonicalResidentID(canonicalUserID(email)) — the shared
 * predicate (I-12), NEVER E_FORMAT. g.s_samuel@u.nus.edu is a real eligible
 * account in this database and an E-format gate here would withhold its
 * baseline PERMANENTLY, not merely mis-derive it once (L-27). The predicate is
 * a post-canonicalization sanity check, never a provenance test, so it is only
 * sound on a value canonicalUserID() has just produced (I-8d) — which is why
 * the email is re-canonicalised here rather than reading a userID out of a
 * document.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUserID, isCanonicalResidentID } from "./lib/identity.mjs";
import { findAll, countWhere, inspectWriteReply, isCommit, banner, abort, nowExt } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();
const ONLY = process.env.ONLY;
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);
const BATCH = 200;

/** Scripts are invoked from the repo root, so resolve a resume file against
 *  cwd first and fall back to the script directory. Print the absolute path —
 *  a resume that silently reads the wrong file is worse than one that fails. */
function resolveOnly(p) {
  const candidates = isAbsolute(p) ? [p] : [resolve(process.cwd(), p), join(HERE, p)];
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error(`ONLY file not found. Tried:\n  ${candidates.join("\n  ")}`);
  return hit;
}

async function main() {
  banner("backfill-resident.mjs", COMMIT);

  // --- 1. Drain User via a raw cursor, projecting ONLY _id + email. -------
  // A row missing the required passwordHash scalar (schema.prisma:353) would
  // throw a TYPED read for the whole collection — this is why the script is
  // $runCommandRaw throughout.
  const users = await findAll(db, "User", { _id: 1, email: 1 });

  // --- 2. Derive, classify, DEDUPE. --------------------------------------
  // Two User rows collapsing to one canonical id is the merged-account case.
  // Report it, never silently pick one: under a STORED baseline a collision is
  // not cosmetic — one of two merged humans silently gets nothing.
  const seen = new Map(), ineligible = [], collisions = [];
  for (const u of users) {
    const id = canonicalUserID(u.email);
    if (!isCanonicalResidentID(id)) { ineligible.push({ _id: u._id, email: u.email ?? null }); continue; }
    if (seen.has(id)) collisions.push({ id, emails: [seen.get(id), u.email] });
    else seen.set(id, u.email);
  }
  console.log(`User rows ${users.length}   eligible ${seen.size}   ineligible ${ineligible.length}   collisions ${collisions.length}`);

  mkdirSync(join(HERE, "backups"), { recursive: true });
  const planPath = join(HERE, "backups", "resident-backfill-plan.json");
  writeFileSync(planPath, JSON.stringify(
    { at: new Date().toISOString(), eligible: [...seen.keys()], ineligible, collisions }, null, 2));
  console.log(`Plan: ${planPath}`);

  if (collisions.length) {
    for (const c of collisions) console.error(`  COLLISION  ${c.id}: ${c.emails.join("  <->  ")}`);
    return abort(`canonical id collisions present — resolve before applying (inventory-rbac.mjs ` +
      `section [2]). This script will not guess which of two merged humans owns the id.`);
  }

  // --- 3. The write set --------------------------------------------------
  let ids = [...seen.keys()];
  if (ONLY) {
    const p = resolveOnly(ONLY);
    console.log(`RESUME from ${p}`);
    const prior = JSON.parse(readFileSync(p, "utf8")).missing ?? [];
    // Intersect with the CURRENT eligible set — an id that stopped being
    // eligible since the last run must not be resurrected from a stale file.
    ids = prior.filter((id) => seen.has(id));
    console.log(`resume set: ${ids.length} of ${prior.length} listed id(s) still eligible`);
  }

  // Report intent BEFORE writing: which of these already hold the baseline.
  const preStored = await findAll(db, "UserRole", { userID: 1, roles: 1 });
  const preHave = new Set(preStored.filter((r) => (r.roles ?? []).includes("resident")).map((r) => r.userID));
  const toGrant = ids.filter((id) => !preHave.has(id));
  const willCreate = ids.filter((id) => !preStored.some((r) => r.userID === id));
  console.log(`\n--- PLAN ---`);
  console.log(`ids in scope:                 ${ids.length}`);
  console.log(`already hold resident:        ${ids.length - toGrant.length}`);
  console.log(`will GAIN resident:           ${toGrant.length}`);
  console.log(`will CREATE a UserRole row:   ${willCreate.length}`);
  if (toGrant.length) console.log(`  ${toGrant.slice(0, 40).join(", ")}${toGrant.length > 40 ? ` … (+${toGrant.length - 40})` : ""}`);

  // --- 4. Batched upsert + $addToSet -------------------------------------
  // Idempotent and order-independent, so an interrupted run is simply re-run.
  //
  // $setOnInsert writes the legacy scalar as "" (I-9 — empty string, NEVER
  // null, NEVER "user") so the deployed OLD client can read these new documents
  // (I-2) and reads them as no-role. Nothing here $sets `role`, so there is no
  // $set/$setOnInsert path conflict.
  //
  // The pendingCheckedAt stamp puts the entire existing population directly on
  // the fast path of the login-time grant applier (doc 02), so the first
  // /api/auth/session read after deploy does NO extra PendingRoleGrant lookup
  // and NO write for ~515 users at once.
  //
  // ordered:false — one failing statement must not abort the batch.
  //
  // $runCommandRaw does NOT throw on a per-write failure: the update command
  // resolves with { ok:1, n, nModified, upserted, writeErrors:[...] }. Read the
  // reply. A batch whose writeErrors are ignored reports success while leaving
  // users with no baseline.
  let nModified = 0, nUpserted = 0;
  const writeErrors = [];
  if (COMMIT) {
    console.log(`\n--- APPLYING (${Math.ceil(ids.length / BATCH)} batch(es) of ${BATCH}) ---`);
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const reply = await raw({
        update: "UserRole",
        ordered: false,
        updates: slice.map((userID) => ({
          q: { userID },
          u: {
            $addToSet: { roles: "resident" },
            $setOnInsert: { role: "", pendingCheckedAt: nowExt() },
          },
          upsert: true,
        })),
      });
      const r = inspectWriteReply(reply, `batch ${i / BATCH + 1}`);
      nModified += r.nModified;
      nUpserted += r.upserted.length;
      if (r.writeErrors.length) writeErrors.push(...r.writeErrors);
      console.log(`  batch ${String(i / BATCH + 1).padStart(3)}: nModified=${r.nModified} upserted=${r.upserted.length} writeErrors=${r.writeErrors.length}`);
    }
    console.log(`\nmodified ${nModified}   upserted ${nUpserted}   writeErrors ${writeErrors.length}`);
    if (writeErrors.length) {
      console.error(`*** WRITE ERRORS: ${JSON.stringify(writeErrors.slice(0, 20), null, 2)}`);
      process.exitCode = 1;
    }
  }

  // --- 5. VERIFY ---------------------------------------------------------
  // A SET DIFFERENCE against what is actually stored, not a count of what we
  // believe we wrote. A count can match by coincidence; a difference cannot.
  // Runs in dry-run mode too, so it doubles as a standing audit.
  const stored = await findAll(db, "UserRole", { userID: 1, roles: 1 });
  const have = new Set(stored.filter((r) => (r.roles ?? []).includes("resident")).map((r) => r.userID));
  const missing = [...seen.keys()].filter((id) => !have.has(id));
  const missingPath = join(HERE, "backups", "resident-backfill-missing.json");
  writeFileSync(missingPath, JSON.stringify({ at: new Date().toISOString(), missing }, null, 2));

  const noLegacy = await countWhere(db, "UserRole", { role: { $exists: false } });

  console.log(`\n=== VERIFY ===`);
  console.log(`eligible ${seen.size}   materialized ${have.size}   MISSING ${missing.length}`);
  console.log(`UserRole rows missing legacy 'role' (must be 0): ${noLegacy}`);
  console.log(`missing-list: ${missingPath}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    // In dry run the MISSING set is simply the work to be done; it is not a
    // failure, so do not fail the process on it here.
    return;
  }

  if (missing.length) {
    console.error(`\n*** MISSING (no stored resident — these users CANNOT BOOK any normal room`);
    console.error(`    until their next session read repairs it): ${missing.join(", ")}`);
    console.error(`*** resume with:`);
    console.error(`    ONLY=backups/resident-backfill-missing.json node scripts/remediation/backfill-resident.mjs --commit`);
    process.exitCode = 1;
  }
  if (noLegacy) {
    console.error(`\n*** ${noLegacy} UserRole row(s) have no legacy 'role'. The STILL-DEPLOYED`);
    console.error(`    Prisma client declares it required and throws on the whole read (I-2).`);
    process.exitCode = 1;
  }
  if (!missing.length && !noLegacy && !writeErrors.length) {
    console.log(`\nClean. Note for Step 12b: immediately before flipping enforcement past "off",`);
    console.log(`re-run this with --commit. It MUST print MISSING 0 AND modified 0 upserted 0.`);
    console.log(`MISSING 0 alone is NOT sufficient — this script $addToSets unconditionally, so`);
    console.log(`the set difference reaches 0 whether or not the creation-time grant points work.`);
    console.log(`Non-zero modified/upserted at that point means a grant point is broken: BLOCK`);
    console.log(`the flip and find out which one.`);
  }
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
