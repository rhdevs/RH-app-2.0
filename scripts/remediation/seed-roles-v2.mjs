/**
 * RBAC v2 step 2: grant roles and configure facility access for EVERY facility.
 *
 *   node scripts/remediation/seed-roles-v2.mjs            # dry run (default)
 *   node scripts/remediation/seed-roles-v2.mjs --commit   # apply
 *   APPLY=yes node scripts/remediation/seed-roles-v2.mjs  # same thing
 *   FORCE_FACILITY=yes ... --commit                       # REPLACE, not union
 *
 * MUST run AFTER Step 8 (the db push that made the legacy scalars optional).
 * This script CREATES documents, and a created document lacking `role` is
 * unreadable by a Prisma client that declares it required (I-2).
 *
 * PROPERTIES THAT ARE LOAD-BEARING — do not "simplify" these away:
 *  - Grants use $addToSet. A re-run must NEVER revoke a role a human granted
 *    through /admin in between runs.
 *  - Facilities are resolved BY facilityID from data/facility-roles.json, never
 *    by facilityName. A rename must be inert; under D-1 a name miss would LOCK
 *    a room rather than open it (lockout mode 2).
 *  - Every facility gets a row, including plain ["resident"] ones, so
 *    rbac-doctor can distinguish "configured normal" from "never configured".
 *  - New rows get $setOnInsert legacy scalars of "" (I-9: empty string, never
 *    null, never "user") so the STILL-DEPLOYED old Prisma client can read them
 *    and so old access.ts keeps today's behaviour ("" is falsy, and
 *    access.ts:36 `if (!required) return true`). Existing rows' legacy scalars
 *    are NEVER touched — that is what keeps SCRC gated exactly as it is today.
 *  - $set and $setOnInsert NEVER target the same field path. That is a MongoDB
 *    ConflictingUpdateOperators PARSE ERROR, not a merge. Note below that the
 *    UserRole grant $sets `role` unconditionally and therefore must NOT also
 *    $setOnInsert it.
 *  - The UserRole legacy mirror is the HIGHEST-PRIVILEGE role, not roles[0].
 *    roles[0] would mirror an admin+jcrc user as "jcrc", so a rollback would
 *    silently demote them. "resident" is NEVER mirrored (doc 06 §0.1).
 *  - E-format validation THROWS before any write. A mis-keyed grant creates a
 *    row no session will ever match: it looks like success and does nothing.
 *  - $runCommandRaw does NOT throw on a per-write failure. Every reply is read.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findAll, numify, inspectWriteReply, isCommit, banner, abort, nowExt,
  E_FORMAT, FACILITY_ROLES, DEFAULT_REQUIRED_ROLES, SENTINEL_FACILITY_ID, legacyMirror,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();
const FORCE_FACILITY = process.env.FORCE_FACILITY === "yes";
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? "E1633673";   // D-4
const ACTOR = "system:seed-roles-v2";

const writeErrors = [];

function loadJson(name) {
  const p = join(HERE, "data", name);
  if (!existsSync(p)) throw new Error(`Missing ${p} — create it (doc 01 Steps 5/10).`);
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Hard gate. Throws BEFORE the first write — validation is cheap, a mis-keyed
 *  grant is invisible. */
function validateIds(ids, label) {
  if (!Array.isArray(ids)) throw new Error(`${label}: expected an array`);
  const bad = ids.filter((id) => !E_FORMAT.test(id));
  if (bad.length) {
    throw new Error(`${label}: ${bad.length} non-E-format userID(s): ${bad.join(", ")}. ` +
      `Grant targets MUST be canonical E-format, not A-format matrics (I-1). ` +
      `(This is a GRANT-TARGET rule only — never use E_FORMAT as an eligibility test, L-27.)`);
  }
  return ids;
}

async function readRoles(userID) {
  const r = await raw({ find: "UserRole", filter: { userID }, limit: 1 });
  const doc = r?.cursor?.firstBatch?.[0];
  return Array.isArray(doc?.roles) ? doc.roles : doc?.role ? [doc.role] : [];
}

async function audit(entry) {
  const reply = await raw({
    insert: "RoleAuditLog",
    documents: [{ at: nowExt(), actorUserID: ACTOR, actorRoles: ["admin"], ok: true, rolesBefore: [], rolesAfter: [], ...entry }],
  });
  const r = inspectWriteReply(reply, `audit ${entry.action}`);
  if (r.writeErrors.length) {
    // The privilege change is already applied at this point. Surface it loudly
    // and fail the run rather than leaving an unaudited grant.
    console.error(`  ! AUDIT WRITE FAILED (privilege change still applied): ${JSON.stringify(r.writeErrors)}`);
    writeErrors.push(r);
  }
}

async function grant(userID, role) {
  const rolesBefore = await readRoles(userID);
  if (rolesBefore.includes(role)) { console.log(`  = ${userID} already has "${role}"`); return; }
  const rolesAfter = [...rolesBefore, role];
  console.log(`  ${COMMIT ? "+" : "~"} ${userID}: ${JSON.stringify(rolesBefore)} -> ${JSON.stringify(rolesAfter)}`);
  if (!COMMIT) return;

  const reply = await raw({
    update: "UserRole",
    ordered: false,
    updates: [{
      q: { userID },
      u: {
        $addToSet: { roles: role },
        // `role` is $set unconditionally, so it must NOT appear in $setOnInsert
        // as well — same path in both operators is a parse error, not a merge.
        $set: { role: legacyMirror(rolesAfter), updatedAt: nowExt(), updatedBy: ACTOR },
      },
      upsert: true,
    }],
  });
  const r = inspectWriteReply(reply, `grant ${role} -> ${userID}`);
  if (r.writeErrors.length) {
    console.error(`  ! WRITE FAILED ${userID}: ${JSON.stringify(r.writeErrors)}`);
    writeErrors.push(r);
    return;                                        // do not audit a write that did not land
  }
  await audit({ targetUserID: userID, action: "grant", rolesBefore, rolesAfter, reason: "RBAC v2 seed" });
}

async function main() {
  banner("seed-roles-v2.mjs", COMMIT);

  // --- precondition: the reviewed facility map ---------------------------
  const facMap = loadJson("facility-roles.json");
  const map = facMap.byFacilityID ?? {};
  if (COMMIT && !facMap._reviewedBy) {
    return abort(`data/facility-roles.json has _reviewedBy: null. Under D-1 this file decides ` +
      `which rooms are LOCKED, and it cannot be derived from the schema. Classify every ` +
      `facility, have a second person review it, set _reviewedBy/_reviewedAt, then re-run. ` +
      `(Run inventory-rbac.mjs for a starter mapping and the full facility list.)`);
  }

  // --- [1] admin ---------------------------------------------------------
  console.log(`[1] grant admin to ${ADMIN_USER_ID}`);
  validateIds([ADMIN_USER_ID], "ADMIN_USER_ID");
  await grant(ADMIN_USER_ID, "admin");

  // --- [2] jcrc roster ---------------------------------------------------
  const jcrc = validateIds(loadJson("jcrc-users.json").jcrc ?? [], "jcrc-users.json");
  console.log(`\n[2] grant jcrc to ${jcrc.length} user(s)`);
  for (const id of jcrc) await grant(id, "jcrc");

  // --- [3] FacilityAccess for EVERY facility, keyed on facilityID --------
  for (const [k, v] of Object.entries(map)) {
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error(`facility-roles.json: facilityID ${k} must be a NON-EMPTY array. ` +
        `Under D-1 an empty array means ["resident"] — say so explicitly.`);
    }
    const bad = v.filter((r) => !FACILITY_ROLES.includes(r));
    if (bad.length) {
      throw new Error(`facility-roles.json: facilityID ${k} has invalid role(s) ${bad.join(", ")}. ` +
        `Allowed: ${FACILITY_ROLES.join(" | ")}. "admin" is an implicit bypass and is never stored.`);
    }
  }

  const facilities = (await findAll(db, "Facilities", { facilityID: 1, facilityName: 1 }))
    .map((f) => ({ facilityID: numify(f.facilityID), facilityName: f.facilityName }))
    .filter((f) => f.facilityID !== SENTINEL_FACILITY_ID)
    .sort((a, b) => a.facilityID - b.facilityID);

  const unmapped = Object.keys(map).filter((k) => !facilities.some((f) => f.facilityID === Number(k)));
  if (unmapped.length) {
    throw new Error(`facility-roles.json references facilityID(s) that do not exist: ${unmapped.join(", ")}. ` +
      `A typo here silently gates nothing while you believe a room is protected.`);
  }

  console.log(`\n[3] FacilityAccess for ${facilities.length} facility/facilities` +
    (FORCE_FACILITY ? "  [FORCE_FACILITY=yes — REPLACING existing arrays]" : ""));
  for (const f of facilities) {
    const desired = map[String(f.facilityID)] ?? DEFAULT_REQUIRED_ROLES;
    const existing = (await raw({ find: "FacilityAccess", filter: { facilityID: f.facilityID }, limit: 1 }))
      ?.cursor?.firstBatch?.[0];
    const cur = existing?.requiredRoles ?? [];
    const after = FORCE_FACILITY || !existing ? desired : [...new Set([...cur, ...desired])];

    if (existing && !FORCE_FACILITY && JSON.stringify([...cur].sort()) !== JSON.stringify([...after].sort())) {
      console.warn(`  ! facilityID ${f.facilityID} already has ${JSON.stringify(cur)}; unioning to ` +
        `${JSON.stringify(after)}. FORCE_FACILITY=yes to replace instead.`);
    }

    console.log(`  ${COMMIT ? "+" : "~"} ${f.facilityID} (${f.facilityName}): ${JSON.stringify(cur)} -> ${JSON.stringify(after)}`);
    if (!COMMIT) continue;

    const reply = await raw({
      update: "FacilityAccess",
      ordered: false,
      updates: [{
        q: { facilityID: f.facilityID },
        u: {
          $set: { requiredRoles: after, updatedAt: nowExt(), updatedBy: ACTOR },
          // Legacy mirror on NEW rows ONLY. "" is falsy, so the still-deployed
          // access.ts:36-39 treats them as open — today's behaviour. Existing
          // rows keep whatever they have (SCRC keeps "jcrc" and stays gated).
          // `requiredRole` is absent from $set above, so there is no conflict.
          $setOnInsert: { requiredRole: "" },
        },
        upsert: true,
      }],
    });
    const r = inspectWriteReply(reply, `facility ${f.facilityID}`);
    if (r.writeErrors.length) {
      console.error(`  ! WRITE FAILED facility ${f.facilityID}: ${JSON.stringify(r.writeErrors)}`);
      writeErrors.push(r);
      continue;
    }
    await audit({ targetFacilityID: f.facilityID, action: "facilityAccess.set", rolesBefore: cur, rolesAfter: after, reason: "RBAC v2 seed" });
  }

  // --- [4] cca_head: report only ----------------------------------------
  console.log(`\n[4] cca_head: NOT derivable. CCA and UserCCA are validator-guarded and neither`);
  console.log(`    has a head/position column, and there is no timestamp to infer "first member"`);
  console.log(`    from. Any heuristic here would be FABRICATING role grants. Grant explicitly`);
  console.log(`    via /admin; every grant also writes a CcaHead row (07-cca-future.md).`);
  console.log(`    CCAs: ${await db.cCA.count()}, UserCCA memberships: ${await db.userCCA.count()}`);

  // --- [5] VERIFY --------------------------------------------------------
  console.log(`\n=== VERIFY ===`);
  const rows = await findAll(db, "UserRole", { userID: 1, roles: 1, role: 1 });
  const admins = rows.filter((d) => (d.roles ?? []).includes("admin")).map((d) => d.userID);
  const jcrcHolders = rows.filter((d) => (d.roles ?? []).includes("jcrc")).map((d) => d.userID);
  const noArr = rows.filter((d) => !Array.isArray(d.roles)).map((d) => d.userID);
  const noLeg = rows.filter((d) => d.role === undefined).map((d) => d.userID);

  console.log(`admins:                              ${admins.join(", ") || "(NONE)"}`);
  console.log(`jcrc holders:                        ${jcrcHolders.length}`);
  console.log(`UserRole rows missing roles[]:       ${noArr.length}${noArr.length ? ` — ${noArr.join(", ")}` : ""}`);
  console.log(`UserRole rows missing legacy 'role': ${noLeg.length}${noLeg.length ? ` — ${noLeg.join(", ")}` : ""}`);

  const fa = (await findAll(db, "FacilityAccess", { facilityID: 1, requiredRoles: 1, requiredRole: 1 }))
    .map((d) => ({ ...d, facilityID: numify(d.facilityID) }));
  for (const d of fa) {
    console.log(`  facility ${d.facilityID}: ${JSON.stringify(d.requiredRoles ?? null)} (legacy ${JSON.stringify(d.requiredRole ?? null)})`);
  }
  const uncovered = facilities.filter((f) => !fa.some((d) => d.facilityID === f.facilityID));
  const badLegacy = fa.filter((d) => d.requiredRole === undefined);
  const hasAdmin = fa.filter((d) => (d.requiredRoles ?? []).includes("admin"));
  console.log(`facilities WITHOUT a FacilityAccess row:            ${uncovered.length}` +
    (uncovered.length ? ` — ${uncovered.map((f) => `${f.facilityID} (${f.facilityName})`).join(", ")}` : ""));
  console.log(`FacilityAccess rows missing legacy 'requiredRole':  ${badLegacy.length}` +
    (badLegacy.length ? ` — ${badLegacy.map((d) => d.facilityID).join(", ")}` : ""));
  console.log(`FacilityAccess rows storing "admin" (must be 0):    ${hasAdmin.length}` +
    (hasAdmin.length ? ` — ${hasAdmin.map((d) => d.facilityID).join(", ")}` : ""));
  console.log(`writeErrors:                                       ${writeErrors.length}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed.`);
    console.log(`REVIEW THIS OUTPUT BEFORE APPLYING. Confirm the admin id, the roster length,`);
    console.log(`and — most importantly — that every facility's "-> [...]" line matches the`);
    console.log(`reviewed facility-roles.json. This is the LAST human checkpoint on room gating.`);
    console.log(`Then: node scripts/remediation/seed-roles-v2.mjs --commit`);
    return;
  }

  let failed = 0;
  const fail = (m) => { console.error(`*** VERIFY FAILED: ${m} ***`); failed++; };
  if (!admins.includes(ADMIN_USER_ID)) fail(`${ADMIN_USER_ID} is not admin`);
  if (noArr.length) fail(`${noArr.length} UserRole row(s) missing roles[]: ${noArr.join(", ")}`);
  if (noLeg.length) fail(`${noLeg.length} UserRole row(s) missing legacy 'role' (I-2): ${noLeg.join(", ")}`);
  if (uncovered.length) fail(`${uncovered.length} facility/facilities with no access row: ${uncovered.map((f) => f.facilityID).join(", ")}`);
  if (badLegacy.length) fail(`${badLegacy.length} FacilityAccess row(s) missing legacy scalar (I-2): ${badLegacy.map((d) => d.facilityID).join(", ")}`);
  if (hasAdmin.length) fail(`${hasAdmin.length} FacilityAccess row(s) store "admin": ${hasAdmin.map((d) => d.facilityID).join(", ")}`);
  if (writeErrors.length) fail(`${writeErrors.length} write error(s) — see above`);
  if (failed) process.exitCode = 1;

  // Stored-baseline PRE-CHECK. NOT a failure here: this script runs BEFORE the
  // resident backfill, so the admin and the jcrc roster legitimately have no
  // "resident" yet. Named so that if the backfill then reports a gap you can
  // tell "the backfill missed them" from "they were never eligible". The
  // backfill's own VERIFY is the blocking gate.
  const noResident = rows.filter((d) => !(d.roles ?? []).includes("resident")).map((d) => d.userID);
  console.log(`\nUserRole rows without stored resident (EXPECTED until backfill-resident.mjs): ` +
    `${noResident.length}${noResident.length ? ` — ${noResident.join(", ")}` : ""}`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
