/**
 * Reconciles the CCA collection to the roster supplied by the JCRC.
 *
 *   node scripts/remediation/reconcile-ccas.mjs            # dry run
 *   node scripts/remediation/reconcile-ccas.mjs --commit   # apply
 *
 * RENAME, DO NOT DELETE-AND-ADD. Most of the diff is naming drift —
 * "(MALE)" -> "(M)", "Soccer" -> "Football", acronyms appended. A rename keeps
 * the ccaID, so every Bookings/UserCCA/CcaHead row that points at it stays
 * attached. Delete-and-add would sever all of them silently, and the counts are
 * not small: RHMP Cast alone carries 531 bookings.
 *
 * DELETES DO NOT CASCADE. `src/server/api/services/cascade.ts` has a
 * deleteCcaCascade that removes bookings by ccaID; this script deliberately
 * does NOT use it. The owner's instruction for the retired CCAs was "no one
 * inherits those bookings, just leave them" — so the CCA row goes and the
 * booking history is left in place, orphaned but intact. An orphaned booking
 * renders without a CCA name; a deleted one is gone. Only one of those is
 * reversible.
 *
 * Everything is keyed on ccaID, never on name: names are exactly what is
 * changing here, so matching on them would be matching on the moving part.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { isCommit, abort, fileStamp } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

/** ccaID -> new name. `expect` is asserted first: if the row no longer holds
 *  that name, the roster was written against different data and we stop. */
const RENAMES = [
  // --- sports: (MALE)/(FEMALE) -> (M)/(F), Soccer -> Football --------------
  [8, "Badminton (MALE)", "Badminton (M)"],
  [9, "Basketball (MALE)", "Basketball (M)"],
  [10, "Floorball (MALE)", "Floorball (M)"],
  [11, "Handball (MALE)", "Handball (M)"],
  [12, "Soccer (MALE)", "Football (M)"],
  [13, "Swimming (MALE)", "Swimming (M)"],
  [14, "Squash (MALE)", "Squash (M)"],
  [15, "Sepak Takraw (MALE)", "Sepak Takraw (M)"],
  [16, "Tennis (MALE)", "Tennis (M)"],
  [17, "Touch Rugby (MALE)", "Touch Rugby (M)"],
  [18, "Table Tennis (MALE)", "Table Tennis (M)"],
  [19, "Volleyball (MALE)", "Volleyball (M)"],
  [24, "Netball (FEMALE)", "Netball (F)"],
  [25, "Badminton (FEMALE)", "Badminton (F)"],
  [26, "Basketball (FEMALE)", "Basketball (F)"],
  [27, "Floorball (FEMALE)", "Floorball (F)"],
  [28, "Handball (FEMALE)", "Handball (F)"],
  [29, "Soccer (FEMALE)", "Football (F)"],
  [30, "Swimming (FEMALE)", "Swimming (F)"],
  [31, "Squash (FEMALE)", "Squash (F)"],
  [32, "Tennis (FEMALE)", "Tennis (F)"],
  [33, "Touch Rugby (FEMALE)", "Touch Rugby (F)"],
  [34, "Table Tennis (FEMALE)", "Table Tennis (F)"],
  [35, "Volleyball (FEMALE)", "Volleyball (F)"],
  // --- acronyms appended ---------------------------------------------------
  [44, "Board of Photography", "Board of Photography (BOP)"],
  [47, "Arts and Graphics", "Arts and Graphics (AnG)"],
  [49, "ComMotion", "ComMotion (IT)"],
  [68, "Hall Promotion Board", "Hall Promotion Board (HPB)"],
  [69, "Alumni and External Affairs Committee", "Alumni and External Affairs Committee (AEAC)"],
  [73, "Sports Management Committee", "Sports Management Committee (SMC)"],
  // --- merge: Bash folds into DnD (67 is deleted below) --------------------
  [66, "Dinner and Dance Committee", "Bash & Dinner and Dance Committee (DnD)"],
  // --- RHOC: the AY20/21 row becomes the 25/26 committee, 26/27 is added ---
  [70, "Raffles Hall Orientation Camp (AY20/21)", "Raffles Hall Orientation Camp (RHOC) Committee 25/26"],
  // --- RHMP: keep the prefix, adopt the roster's names ----------------------
  [55, "RHMP Producer Team", "RHMP Producers + Finance"],
  [56, "RHMP Cast", "RHMP Cast (Directors)"],
];

/**
 * ccaID -> ccaID for a MERGE, applied BEFORE the source CCA is deleted.
 *
 * Only Bash. It differs in kind from the retired CCAs: those are gone, so their
 * bookings have nowhere to point. This committee still exists under a combined
 * name, so its history follows it rather than being orphaned. Ordering matters
 * — a crash after the reassign leaves a CCA whose bookings have already moved,
 * which is harmless and re-runnable; a crash the other way round would leave
 * bookings pointing at a row that no longer exists.
 */
const REASSIGN = [[67, 66, "Bash -> Bash & Dinner and Dance Committee (DnD)"]];

/**
 * Retired. Their rows go; their bookings stay (see the header).
 * 52 Auditor and 53 Finance Team are deliberately NOT here — the owner kept
 * them despite their absence from the roster.
 */
const DELETES = [
  [51, "Vacation Storage"],
  [67, "Bash"], // merged into 66
  [77, "Raffles Volunteer Corp"], // replaced by the four RVC teams below
  [78, "Overseas Community Involvement Programme"],
  [80, "JCRC"],
  [81, "Block 1"],
  [82, "Block 2"],
  [83, "Block 3"],
  [84, "Block 4"],
  [85, "Block 5"],
  [86, "Block 6"],
  [87, "Block 7"],
  [88, "Block 8"],
  [89, "Raffles Hall"],
];

/** New CCAs. ccaIDs are allocated from max+1 at run time, never reused from a
 *  deleted row — a recycled id would silently adopt the retired CCA's bookings. */
const ADDS = [
  ["RVC Special Projects", "Committees"],
  ["RVC Children", "Committees"],
  ["RVC Pioneers", "Committees"],
  ["RVC Special Needs", "Committees"],
  ["BakeRH's", "Committees"],
  ["Raffles Hall Orientation Camp (RHOC) Committee 26/27", "Committees"],
  ["RHMP Ensemble", "RHMP"],
  ["RHMP Stage Managers", "RHMP"],
  ["RHMP Marketing", "RHMP"],
  ["RHMP Relations", "RHMP"],
  ["RHMP Composers", "RHMP"],
];

const cnt = async (collection, filter) => {
  const r = await db.$runCommandRaw({
    aggregate: collection,
    pipeline: [{ $match: filter }, { $count: "n" }],
    cursor: {},
  });
  return r?.cursor?.firstBatch?.[0]?.n ?? 0;
};

async function main() {
  console.log(`\n=== reconcile-ccas.mjs ===`);
  console.log(`MODE: ${COMMIT ? "COMMIT (writes)" : "DRY RUN (no writes)"}`);
  console.log(`at:   ${new Date().toISOString()}\n`);

  const before = await db.cCA.findMany({ orderBy: { ccaID: "asc" } });
  const byID = new Map(before.map((c) => [c.ccaID, c]));
  console.log(`CCAs before: ${before.length}`);

  // --- precondition: every rename/delete target still says what we expect ---
  const bad = [];
  for (const [id, expect] of RENAMES) {
    const row = byID.get(id);
    if (!row) bad.push(`rename ${id}: NOT FOUND`);
    else if (row.ccaName !== expect)
      bad.push(`rename ${id}: is ${JSON.stringify(row.ccaName)}, roster written against ${JSON.stringify(expect)}`);
  }
  for (const [id, expect] of DELETES) {
    const row = byID.get(id);
    if (!row) bad.push(`delete ${id}: NOT FOUND`);
    else if (row.ccaName !== expect)
      bad.push(`delete ${id}: is ${JSON.stringify(row.ccaName)}, expected ${JSON.stringify(expect)}`);
  }
  if (bad.length) {
    for (const b of bad) console.error(`  BLOCK  ${b}`);
    return abort("the collection does not match what this roster was written against. Re-read it and re-derive the plan.");
  }

  // --- name collisions after rename ----------------------------------------
  const finalNames = new Map();
  const deleted = new Set(DELETES.map(([id]) => id));
  const renamed = new Map(RENAMES.map(([id, , to]) => [id, to]));
  for (const c of before) {
    if (deleted.has(c.ccaID)) continue;
    const name = renamed.get(c.ccaID) ?? c.ccaName;
    if (finalNames.has(name)) bad.push(`duplicate name after rename: ${JSON.stringify(name)} (ccaID ${finalNames.get(name)} and ${c.ccaID})`);
    finalNames.set(name, c.ccaID);
  }
  for (const [name] of ADDS) {
    if (finalNames.has(name)) bad.push(`ADD would duplicate an existing name: ${JSON.stringify(name)} (ccaID ${finalNames.get(name)})`);
    finalNames.set(name, "new");
  }
  if (bad.length) {
    for (const b of bad) console.error(`  BLOCK  ${b}`);
    return abort("plan would create duplicate CCA names.");
  }

  // --- plan -----------------------------------------------------------------
  console.log(`\n--- RENAME (${RENAMES.length}) — ccaID kept, all references stay attached ---`);
  for (const [id, from, to] of RENAMES) console.log(`  ~ ${String(id).padStart(3)}  ${from}\n         -> ${to}`);

  console.log(`\n--- DELETE (${DELETES.length}) — bookings deliberately NOT cascaded ---`);
  console.log(`\n--- REASSIGN (${REASSIGN.length}): merge, history follows the CCA ---`);
  for (const [from, to, why] of REASSIGN) {
    const n = await cnt("Bookings", { ccaID: from });
    console.log(`  > ${why}`);
    console.log(`      ${n} booking(s): ccaID ${from} -> ${to}`);
  }

  let orphaned = 0;
  for (const [id, name] of DELETES) {
    const bk = await cnt("Bookings", { ccaID: id });
    const uc = await cnt("UserCCA", { ccaID: id });
    const ch = await cnt("CcaHead", { ccaID: id });
    // a reassigned source contributes no orphans - its rows have already moved
    if (!REASSIGN.some(([from]) => from === id)) orphaned += bk;
    console.log(`  - ${String(id).padStart(3)}  ${String(name).padEnd(44)} bookings=${String(bk).padStart(4)} userCCA=${uc} ccaHead=${ch}`);
  }
  console.log(`\n  ${orphaned} booking(s) will be left orphaned — kept on purpose, not cascaded.`);

  const maxID = Math.max(...before.map((c) => c.ccaID));
  console.log(`\n--- ADD (${ADDS.length}) — ccaIDs from ${maxID + 1}, never reusing a deleted id ---`);
  ADDS.forEach(([name, cat], i) => console.log(`  + ${String(maxID + 1 + i).padStart(3)}  ${String(name).padEnd(44)} ${cat}`));

  console.log(`\n  CCAs after: ${before.length - DELETES.length + ADDS.length}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.\n`);
    return;
  }

  // --- backup ---------------------------------------------------------------
  const out = path.join(process.cwd(), "scripts", "remediation", "backups", `reconcile-ccas-${fileStamp()}.json`);
  try {
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), before }, null, 2), "utf8");
    console.log(`\nBackup written: ${out}`);
  } catch (e) {
    return abort(`could not write the backup (${String(e?.message ?? e)}). Refusing to proceed without one.`);
  }

  let failures = 0;
  for (const [id, , to] of RENAMES) {
    try { await db.cCA.update({ where: { ccaID: id }, data: { ccaName: to } }); }
    catch (e) { failures++; console.error(`  ! rename ${id}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  console.log(`  renamed ${RENAMES.length - failures}/${RENAMES.length}`);

  for (const [from, to, why] of REASSIGN) {
    const reply = await db.$runCommandRaw({
      update: "Bookings",
      updates: [{ q: { ccaID: from }, u: { $set: { ccaID: to } }, multi: true }],
    });
    const errs = reply?.writeErrors ?? [];
    if (errs.length) {
      failures++;
      console.error(`  ! reassign ${why}: ${JSON.stringify(errs).slice(0, 160)}`);
    } else {
      console.log(`  > reassigned ${reply?.nModified ?? 0} booking(s): ${why}`);
    }
  }

  let del = 0;
  for (const [id] of DELETES) {
    try { await db.cCA.delete({ where: { ccaID: id } }); del++; }
    catch (e) { failures++; console.error(`  ! delete ${id}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  console.log(`  deleted ${del}/${DELETES.length}`);

  let add = 0;
  for (let i = 0; i < ADDS.length; i++) {
    const [name, category] = ADDS[i];
    try { await db.cCA.create({ data: { ccaID: maxID + 1 + i, ccaName: name, category } }); add++; }
    catch (e) { failures++; console.error(`  ! add ${name}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  console.log(`  added ${add}/${ADDS.length}`);

  // --- verify ---------------------------------------------------------------
  const after = await db.cCA.findMany({ orderBy: { ccaID: "asc" } });
  const names = after.map((c) => c.ccaName);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  console.log(`\n=== VERIFY ===`);
  console.log(`CCAs after:        ${after.length}`);
  console.log(`duplicate names:   ${dupes.length} ${dupes.length ? JSON.stringify([...new Set(dupes)]) : ""}`);
  for (const [from, , why] of REASSIGN) {
    const left = await cnt("Bookings", { ccaID: from });
    console.log(`bookings still on ${from}: ${left} (must be 0) - ${why}`);
    if (left) failures++;
  }
  console.log(`failures:          ${failures}`);
  if (failures || dupes.length) return abort("reconcile did not complete cleanly — the backup holds every pre-image.");
  console.log(`\nDone.\n`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
