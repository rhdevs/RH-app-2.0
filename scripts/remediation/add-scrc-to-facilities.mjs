/**
 * Adds "scrc" to EVERY facility's `FacilityAccess.requiredRoles`, so the hall
 * office can book every room.
 *
 *   node scripts/remediation/add-scrc-to-facilities.mjs --actor E1633673
 *   node scripts/remediation/add-scrc-to-facilities.mjs --actor E1633673 --commit
 *
 * Dry run by DEFAULT. It prints a full before/after table for all 47 rows, and
 * it exits 1 without writing anything if ANY row fails the refusals below.
 *
 * ===========================================================================
 * READ THIS BEFORE YOU CHANGE ANY LINE OF IT. THE ONE-WAY DOOR.
 * ===========================================================================
 *
 * `requiredRoles: []` — an EMPTY ARRAY, or an absent field — IS NOT "no
 * restriction to preserve". It is a DISTINCT STATE with two different meanings
 * depending on the enforcement mode, and BOTH of them are destroyed by writing
 * ["scrc"] over it:
 *
 *   - `canBookLegacy` (services/access.ts:315) opens with
 *         if (rawRequiredRoles.length === 0) return true;
 *     i.e. in mode `off`, an empty array means OPEN TO EVERYONE — the pre-D-1
 *     behaviour. Writing ["scrc"] there converts an open room into an
 *     scrc-ONLY room.
 *   - `getFacilityRequiredRoles` (access.ts:272) and `canBookWithRoles` (:294)
 *     re-default an empty array to ["resident"], i.e. in `permissive` and
 *     `enforce` an empty array means EVERY RESIDENT. Writing ["scrc"] there
 *     converts a resident room into an scrc-ONLY room.
 *
 * In other words: on an empty array, this operation is not an ADDITION. IT IS A
 * REMOVAL OF EVERYONE ELSE. The same is true of CREATING a row where none
 * exists, because a facility with no FacilityAccess row defaults to
 * ["resident"] (access.ts:272) — so a freshly created ["scrc"] row silently
 * takes that room away from every resident in the hall.
 *
 * There is no signal when this goes wrong. No error, no audit anomaly, no
 * denial in the logs the operator is watching: residents simply stop seeing the
 * room in the picker (`getBookableFacilityMap` uses the same predicate) and
 * start being denied at booking time, and the cause looks like a bug in the
 * booking code rather than a row somebody rewrote. This is the single most
 * destructive mistake available in this phase.
 *
 * So this script REFUSES — it does not "fix", it does not "default", it does
 * not skip-and-continue. One bad row aborts the whole run, because a partial
 * run over 47 facilities is harder to reason about than no run at all.
 *
 * ---------------------------------------------------------------------------
 * REFUSALS (each aborts the entire run, before any write)
 * ---------------------------------------------------------------------------
 *   EMPTY_REQUIRED_ROLES   a FacilityAccess row whose requiredRoles is empty or
 *                          absent. See above — the write would be a removal.
 *   NO_ACCESS_ROW          a Facilities row (excluding the -1 sentinel) with no
 *                          FacilityAccess row. Creating one is the same trap.
 *   DUPLICATE_ACCESS_ROW   two FacilityAccess rows for one facilityID. The
 *                          `where: { facilityID }` update is then ambiguous and
 *                          Prisma would refuse anyway — caught here so it is a
 *                          refusal rather than a mid-run failure with some rows
 *                          already written.
 *   NOT_A_SUPERSET         a self-check: the computed `next` is not a superset
 *                          of `current`. Cannot happen with a union, which is
 *                          exactly why it is asserted — it turns "this script
 *                          only ever adds" from a claim into a checked
 *                          invariant, for every future edit to this file.
 *   BAD_ACTOR              --actor missing or not a well-shaped identity key.
 *
 * Already contains "scrc" is NOT a refusal — it is a SKIP. The script is
 * idempotent: a second run writes nothing and reports 0 changed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WRITES, AND WHAT IT DELIBERATELY DOES NOT TOUCH
 * ---------------------------------------------------------------------------
 *   next = [...new Set([...current.requiredRoles, "scrc"])]
 *
 * `update` ONLY — never `create`, never `upsert`. It writes `requiredRoles`,
 * `updatedAt` and `updatedBy`, which is exactly the UPDATE branch of
 * `admin.setFacilityAccess` (routers/admin.ts:2702-2731).
 *
 * `requiredRole` — the LEGACY SCALAR — is NOT touched, and that matters. The
 * update branch of setFacilityAccess leaves it alone for a reason: an existing
 * gated row (the SCRC Room's "jcrc") keeps its real legacy value so that a
 * revert to the pre-v2 access.ts does not silently UN-GATE the room, while the
 * 46 rooms keep their "" so a revert restores today's open-by-default. Writing
 * "scrc" into that scalar would be uninterpretable to the old code and would
 * demote a jcrc+scrc holder on rollback — the same argument PRECEDENCE in
 * lib/rbac.mjs makes for leaving "scrc" out of the mirror. `facilityID` is not
 * touched either; it is the key.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCRIPT AND NOT 47 CLICKS IN /admin/facilities
 * ---------------------------------------------------------------------------
 * The UI writes a SET payload: whatever boxes are ticked becomes the whole
 * array. Forty-seven of those is forty-seven chances to drop `cca_head` from a
 * room by mis-clicking, silently, with a perfectly clean audit row recording
 * the mistake as intentional. This computes a UNION, cannot subtract, prints
 * the whole before/after table before it does anything, and writes the same
 * `facilityAccess.set` audit row per facility that the UI would.
 *
 * ---------------------------------------------------------------------------
 * "EVERY MODIFIED FACILITY IS AUDITED" — A PROPERTY, NOT A HOPE
 * ---------------------------------------------------------------------------
 *
 * The update and its audit row go through ONE `db.$transaction([...])` PER
 * FACILITY, so for any given room "the gate changed" and "there is a
 * RoleAuditLog row saying so" are the same event. They cannot come apart.
 *
 * THEY USED TO BE ABLE TO, and the failure was invisible in a way worth
 * spelling out, because it is why the transaction is here rather than a comment
 * saying to be careful. The two writes sat in one `try`. If the update landed
 * and the audit `create` threw, the facility was reported FAILED — while the
 * row WAS modified and no audit row existed. The verify pass could not see it:
 * it checks only that `scrc` is present and that no role was lost, and both are
 * true of an unaudited-but-correct row. And the repair never came, because a
 * corrective re-run reads `already === true` for that facility and SKIPS it
 * permanently. An un-audited privilege change that no re-run will ever notice
 * is precisely the residue this whole phase is written to avoid.
 *
 * Since a transaction still has prerequisites (a replica set — Atlas is one —
 * and both collections existing, which they do since phase 1), the verify pass
 * ALSO cross-checks the two: any facility reported FAILED whose re-read now
 * CONTAINS "scrc" is surfaced as MODIFIED BUT POSSIBLY UNAUDITED, with the exact
 * `RoleAuditLog` document printed as JSON so it can be inserted by hand. That
 * path exits 1 like every other bad outcome.
 *
 * PRE-REQUISITE: "scrc" must be in FACILITY_ROLES in lib/rbac.mjs (it is —
 * phase 1). Checked below rather than assumed.
 */
import { PrismaClient } from "@prisma/client";
import { isCanonicalResidentID } from "./lib/identity.mjs";
import {
  findAll,
  numify,
  isCommit,
  banner,
  abort,
  FACILITY_ROLES,
  SENTINEL_FACILITY_ID,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

const ROLE = "scrc";

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
}
const ACTOR = (argOf("--actor") ?? "").trim();

const refusals = [];
const refuse = (code, detail) => refusals.push({ code, detail });

async function main() {
  banner("add-scrc-to-facilities.mjs", COMMIT);
  console.log(`  actor: ${JSON.stringify(ACTOR)}`);

  // -- 0. preconditions -----------------------------------------------------
  //
  // isCanonicalResidentID is a SHAPE test (non-empty, contains no '@'). It is
  // the right predicate for an actor id precisely because it is NOT an E-format
  // test: "G.S_SAMUEL" is a real account (L-27) and an EXT pin is a legal
  // principal key, and refusing either would be the same class of mistake as
  // gating eligibility on /^E\d{7}$/.
  if (!isCanonicalResidentID(ACTOR)) {
    console.log(`\nusage: node scripts/remediation/add-scrc-to-facilities.mjs --actor <userID> [--commit]`);
    return abort(
      `--actor is required and must be a well-shaped identity key. It is written to ` +
        `RoleAuditLog.actorUserID and FacilityAccess.updatedBy for all 47 rows; an audit ` +
        `trail that names nobody is not an audit trail.`,
    );
  }
  if (!FACILITY_ROLES.includes(ROLE)) {
    return abort(
      `"${ROLE}" is not in FACILITY_ROLES (lib/rbac.mjs). Phase 1 has not landed here, and ` +
        `rbac-doctor.mjs would report every row this script writes as out-of-vocabulary.`,
    );
  }

  // -- 1. read --------------------------------------------------------------
  //
  // findAll, not a bare `find`: a single raw reply is capped at 101 documents by
  // default and at 16MB regardless, and a script that reads a PREFIX of
  // FacilityAccess would silently leave the unread rooms un-gated while
  // reporting success. findAll pages to exhaustion and cross-checks against an
  // independent $count.
  //
  // numify on facilityID: extended JSON hands back {$numberInt:"17"}, and a
  // string-vs-number mismatch here would make every row look unmatched.
  const access = (await findAll(db, "FacilityAccess", { facilityID: 1, requiredRoles: 1, requiredRole: 1 }))
    .map((a) => ({ ...a, facilityID: numify(a.facilityID) }));
  const facilities = (await findAll(db, "Facilities", { facilityID: 1, facilityName: 1 }))
    .map((f) => ({ ...f, facilityID: numify(f.facilityID) }));

  const realFacilities = facilities.filter((f) => f.facilityID !== SENTINEL_FACILITY_ID);
  const nameOf = new Map(realFacilities.map((f) => [f.facilityID, String(f.facilityName ?? "")]));

  console.log(`\n--- [1] population ---`);
  console.log(`  Facilities rows (excl. sentinel ${SENTINEL_FACILITY_ID}): ${realFacilities.length}`);
  console.log(`  FacilityAccess rows:                        ${access.length}`);

  // -- 2. refusal: duplicate FacilityAccess rows ----------------------------
  const counts = new Map();
  for (const a of access) counts.set(a.facilityID, (counts.get(a.facilityID) ?? 0) + 1);
  for (const [fid, n] of counts) {
    if (n > 1) {
      refuse(
        "DUPLICATE_ACCESS_ROW",
        `facilityID ${fid} has ${n} FacilityAccess rows. \`where: { facilityID }\` is ` +
          `ambiguous, so the update would fail mid-run with some rows already written. ` +
          `The @unique index on facilityID should have made this impossible — check it.`,
      );
    }
  }

  // -- 3. refusal: a facility with no FacilityAccess row --------------------
  const configured = new Set(access.map((a) => a.facilityID));
  for (const f of realFacilities) {
    if (!configured.has(f.facilityID)) {
      refuse(
        "NO_ACCESS_ROW",
        `facility ${f.facilityID} (${nameOf.get(f.facilityID)}) has NO FacilityAccess row. ` +
          `A facility with no row defaults to ["resident"] (access.ts:272), so CREATING one ` +
          `containing only "${ROLE}" would take this room away from every resident in the ` +
          `hall. This script never creates. Configure the room through /admin/facilities ` +
          `first (which writes the full intended role set and an audit row), then re-run.`,
      );
    }
  }

  // -- 4. plan, per row -----------------------------------------------------
  const plan = [];
  const sentinelRows = [];
  for (const a of [...access].sort((x, y) => x.facilityID - y.facilityID)) {
    // facilityID -1 is the sentinel Calender_v2.tsx filters out. It is not a
    // room, nobody can book it, and granting a role on it would produce an
    // audit row about a facility that does not exist. Reported, never written,
    // and NOT a refusal — its shape says nothing about the real rooms.
    if (a.facilityID === SENTINEL_FACILITY_ID) {
      sentinelRows.push(a.facilityID);
      continue;
    }

    const current = Array.isArray(a.requiredRoles) ? a.requiredRoles : null;

    // THE ONE-WAY DOOR. Empty or absent -> refuse. Read the header.
    if (current === null || current.length === 0) {
      refuse(
        "EMPTY_REQUIRED_ROLES",
        `facility ${a.facilityID} (${nameOf.get(a.facilityID) ?? "unknown"}) has ` +
          `requiredRoles=${JSON.stringify(a.requiredRoles ?? null)}. An empty/absent array is a ` +
          `DISTINCT STATE: mode "off" reads it as open-to-everyone (access.ts:315) and ` +
          `"permissive"/"enforce" re-default it to ["resident"] (access.ts:272). Writing ` +
          `["${ROLE}"] here would not ADD the hall office, it would REMOVE EVERYONE ELSE, ` +
          `silently. Decide the intended role set for this room and write it through ` +
          `/admin/facilities, then re-run.`,
      );
      continue;
    }

    // The union. It cannot subtract — and the assertion below is what keeps
    // that true for whoever edits this next.
    const next = [...new Set([...current, ROLE])];
    if (!current.every((r) => next.includes(r))) {
      refuse(
        "NOT_A_SUPERSET",
        `facility ${a.facilityID}: computed ${JSON.stringify(next)} is not a superset of ` +
          `${JSON.stringify(current)}. This is a self-check on the union above; if it ever ` +
          `fires, the computation was changed into something that can REMOVE a role.`,
      );
      continue;
    }

    const already = current.includes(ROLE);
    plan.push({
      facilityID: a.facilityID,
      name: nameOf.get(a.facilityID) ?? "(no Facilities row)",
      legacy: a.requiredRole,
      current,
      next,
      already,
      orphan: !nameOf.has(a.facilityID),
    });
  }

  // -- 5. the table ---------------------------------------------------------
  console.log(`\n--- [2] before / after (ALL rows, including skips) ---`);
  console.log(
    `  ${"fid".padStart(4)}  ${"facility".padEnd(28)} ${"legacy".padEnd(10)} ` +
      `${"before".padEnd(32)} -> after`,
  );
  for (const p of plan) {
    const mark = p.already ? "=" : COMMIT ? "+" : "~";
    console.log(
      `  ${mark} ${String(p.facilityID).padStart(2)}  ${String(p.name).slice(0, 28).padEnd(28)} ` +
        `${JSON.stringify(p.legacy ?? null).padEnd(10)} ${JSON.stringify(p.current).padEnd(32)} -> ` +
        `${p.already ? "(unchanged)" : JSON.stringify(p.next)}`,
    );
  }

  // Informational, NOT a refusal. A FacilityAccess row whose facilityID has no
  // Facilities row is a gate on a room that does not exist; adding a role to it
  // changes nothing for anyone. Reported so it is visible, and included in the
  // write set so the collection stays uniform.
  if (sentinelRows.length) {
    console.log(
      `\n  note: skipped the facilityID ${SENTINEL_FACILITY_ID} sentinel row — not a room, ` +
        `not bookable, no audit row written for it.`,
    );
  }

  const orphans = plan.filter((p) => p.orphan).map((p) => p.facilityID);
  if (orphans.length) {
    console.log(
      `\n  note: ${orphans.length} FacilityAccess row(s) have no matching Facilities row ` +
        `[${orphans.join(", ")}]. Gates on rooms that do not exist — harmless, and included ` +
        `for uniformity. Not a refusal.`,
    );
  }

  const toWrite = plan.filter((p) => !p.already);
  const skipped = plan.length - toWrite.length;
  console.log(`\n  rows already containing "${ROLE}" (skipped): ${skipped}`);
  console.log(`  rows to update:                          ${toWrite.length}`);

  // -- 6. verdict -----------------------------------------------------------
  if (refusals.length) {
    console.error(`\n--- REFUSED (${refusals.length}) — NOTHING WAS WRITTEN ---`);
    for (const r of refusals) console.error(`  ${r.code}\n      ${r.detail}\n`);
    return abort(
      `the run is aborted in full. A partial pass over 47 facilities is harder to reason ` +
        `about than none, and every refusal above describes a write that would REMOVE ` +
        `access rather than add it.`,
    );
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing was written. Read the table above line by line, then`);
    console.log(`re-run with --commit. Every "after" must be a SUPERSET of its "before".`);
    return;
  }

  // -- 7. write -------------------------------------------------------------
  //
  // actorRoles is read from the database rather than hardcoded: the column
  // means "the actor's roles AT THE TIME", and stamping a value on faith
  // records a claim instead of a fact. Falls back to ["admin"] only if the
  // actor has no UserRole row, which is itself worth seeing in the output.
  const actorRow = await db.userRole
    .findUnique({ where: { userID: ACTOR }, select: { roles: true } })
    .catch(() => null);
  const actorRoles = actorRow?.roles?.length ? actorRow.roles : ["admin"];
  console.log(`\n--- [3] writing (actorRoles=${JSON.stringify(actorRoles)}${actorRow ? "" : " — no UserRole row for the actor; using the default"}) ---`);

  /**
   * The audit document for one facility, built once so the same object can be
   * WRITTEN and — if a write is ever reported failed over a row that turns out
   * to be modified — PRINTED for hand insertion.
   *
   * Field-for-field identical to writeAudit() in routers/admin.ts, including
   * the fields it sets to null. `before` is the same expression
   * admin.setFacilityAccess uses, kept verbatim so a row written here and a row
   * written by the UI carry the same rolesBefore; the refusals above already
   * guarantee requiredRoles is non-empty, so in practice it is always the first
   * branch.
   */
  const auditDocFor = (p) => ({
    actorUserID: ACTOR,
    actorRoles,
    targetUserID: null,
    targetFacilityID: p.facilityID,
    targetCcaID: null,
    targetEventID: null,
    action: "facilityAccess.set",
    rolesBefore: p.current.length ? p.current : p.legacy ? [p.legacy] : [],
    rolesAfter: p.next,
    reason: `script:add-scrc-to-facilities`,
    ok: true,
    denyReason: null,
    batchId: null,
  });

  let written = 0;
  const failures = [];
  const failedIDs = new Set();
  const auditDocs = new Map();
  for (const p of toWrite) {
    auditDocs.set(p.facilityID, auditDocFor(p));
    try {
      // ONE TRANSACTION PER FACILITY, so "the gate changed" and "the audit row
      // exists" are one event. Read the header: with these two writes merely
      // sequential, an audit failure after a successful update produced a
      // facility reported FAILED that had in fact been MODIFIED and never
      // audited — invisible to the verify pass, and skipped forever by any
      // corrective re-run because `already` is then true.
      //
      // Per facility rather than one transaction over all 47: a single
      // transaction spanning 94 writes would be far past Prisma's default
      // 5-second budget, and the run is already designed to be resumable
      // room-by-room (the union is idempotent, so a re-run re-does nothing).
      //
      // update, never upsert. If the row vanished between the read and here,
      // Prisma throws P2025 and this facility is reported as a failure rather
      // than quietly CREATED — which is the NO_ACCESS_ROW trap by another door.
      await db.$transaction([
        db.facilityAccess.update({
          where: { facilityID: p.facilityID },
          data: {
            requiredRoles: p.next,
            updatedAt: new Date(),
            updatedBy: ACTOR,
            // requiredRole is ABSENT from this payload on purpose. See the header.
          },
        }),
        db.roleAuditLog.create({ data: auditDocs.get(p.facilityID) }),
      ]);
      written++;
      console.log(`  + ${String(p.facilityID).padStart(2)}  ${JSON.stringify(p.current)} -> ${JSON.stringify(p.next)}`);
    } catch (e) {
      failures.push(`facility ${p.facilityID}: ${String(e?.message ?? e)}`);
      failedIDs.add(p.facilityID);
      console.error(`  ! ${String(p.facilityID).padStart(2)}  FAILED: ${String(e?.message ?? e)}`);
    }
  }

  // -- 8. verify ------------------------------------------------------------
  //
  // Re-read, do not trust the writes. This is the only line that proves the
  // outcome, and it also catches the case nobody expects: a row that came back
  // NARROWER than it went in.
  console.log(`\n=== VERIFY (re-read) ===`);
  const after = (await findAll(db, "FacilityAccess", { facilityID: 1, requiredRoles: 1 }))
    .map((a) => ({ ...a, facilityID: numify(a.facilityID) }));
  const afterMap = new Map(after.map((a) => [a.facilityID, a.requiredRoles ?? []]));

  const bad = [];
  const unaudited = [];
  for (const p of plan) {
    const now = afterMap.get(p.facilityID);
    if (!now) {
      bad.push(`facility ${p.facilityID}: FacilityAccess row is GONE`);
      continue;
    }
    if (!now.includes(ROLE)) bad.push(`facility ${p.facilityID}: still lacks "${ROLE}" (${JSON.stringify(now)})`);
    const lost = p.current.filter((r) => !now.includes(r));
    if (lost.length) {
      bad.push(
        `facility ${p.facilityID}: LOST ${JSON.stringify(lost)} — was ${JSON.stringify(p.current)}, ` +
          `is now ${JSON.stringify(now)}. THIS IS THE FAILURE THIS SCRIPT EXISTS TO PREVENT.`,
      );
    }

    // MODIFIED BUT POSSIBLY UNAUDITED — its OWN outcome, distinct from "failed".
    //
    // The per-facility transaction is supposed to make this unreachable, and on
    // a replica set with both collections present it is. It is checked anyway
    // because the cost of being wrong is an unaudited privilege change that no
    // re-run will ever revisit: the next run sees `already === true` and skips
    // the room forever. A facility this run reported FAILED, whose re-read now
    // carries "scrc", is exactly that shape.
    if (failedIDs.has(p.facilityID) && now.includes(ROLE)) {
      unaudited.push(p.facilityID);
    }
  }

  console.log(`  rows updated:        ${written}   (each with its audit row, in one transaction)`);
  console.log(`  rows skipped:        ${skipped}`);
  console.log(`  write failures:      ${failures.length}`);
  console.log(`  modified-but-possibly-unaudited: ${unaudited.length}${unaudited.length ? `  [${unaudited.join(", ")}]` : ""}`);
  // Sentinel excluded from the denominator so "47 of 47" means what it says.
  const realAfter = [...afterMap].filter(([fid]) => fid !== SENTINEL_FACILITY_ID);
  console.log(`  rows now with scrc:  ${realAfter.filter(([, r]) => r.includes(ROLE)).length} of ${realAfter.length}`);

  console.log(`\n================================`);

  // MODIFIED BUT UNAUDITED, reported as its own outcome and BEFORE the generic
  // failure list, with the exact document to insert. A re-run cannot repair
  // this: the row now contains "scrc", so the next run computes `already` true
  // and skips the facility. The repair has to be done here, by hand, now.
  if (unaudited.length) {
    console.error(`\n  *** MODIFIED BUT POSSIBLY UNAUDITED — ${unaudited.length} facility(ies) ***\n`);
    console.error(
      `  These rows were reported FAILED above, but the re-read shows them carrying\n` +
        `  "${ROLE}". The gate CHANGED. Whether the matching RoleAuditLog row exists is\n` +
        `  unknown — the two writes go in one transaction, so it should, but a run that\n` +
        `  lands here has already violated that assumption once.\n\n` +
        `  RE-RUNNING THIS SCRIPT WILL NOT FIX IT. The union is idempotent, so the next\n` +
        `  run sees the role already present and skips the facility permanently.\n\n` +
        `  For each facility below: query RoleAuditLog for action="facilityAccess.set"\n` +
        `  with targetFacilityID = that id and reason="script:add-scrc-to-facilities".\n` +
        `  If there is no such row, insert the document printed under it verbatim\n` +
        `  (db.RoleAuditLog.insertOne(<doc>), adding the collection's own timestamp\n` +
        `  field as the model requires).\n`,
    );
    for (const fid of unaudited) {
      console.error(`  --- facility ${fid} ---`);
      console.error(`  ${JSON.stringify(auditDocs.get(fid))}`);
    }
  }

  if (failures.length || bad.length || unaudited.length) {
    for (const f of failures) console.error(`  FAIL  ${f}`);
    for (const b of bad) console.error(`  RED   ${b}`);
    return abort(`the facility gates are NOT in the intended state. Read every line above.`);
  }
  console.log(`Every FacilityAccess row now grants "${ROLE}", and no row lost a role.`);
  console.log(`Every row this run modified was audited in the SAME transaction as the change.`);
  console.log(`The legacy requiredRole scalar was not touched on any row.`);
}

main()
  // Conditional on the exit code: printing "Done." under an ABORT banner is how
  // an operator skim-reads a refusal as a success.
  .then(() => console.log(process.exitCode ? "\nAborted — see above." : "\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
