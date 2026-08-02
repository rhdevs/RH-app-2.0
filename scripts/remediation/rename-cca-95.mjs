/**
 * One-off rename: "BakeRH's" -> "BakeRHs and Cooks".
 *
 *   node scripts/remediation/rename-cca-95.mjs            # dry run
 *   node scripts/remediation/rename-cca-95.mjs --commit   # apply
 *
 * KEYED ON ccaID, asserting the name. Same rule as reconcile-ccas.mjs: a rename
 * keeps the ccaID, so every Bookings / UserCCA / CcaHead / CcaProfile /
 * CcaApplication row that points at it stays attached. Delete-and-recreate would
 * sever all of them silently, which is why this is an update and nothing else.
 *
 * The apostrophe is the point of the change and also the reason to assert the
 * old value exactly: "BakeRH's" with a typographic apostrophe (U+2019) is a
 * DIFFERENT string from the ASCII one, and a rename that silently matched
 * neither would report success having changed nothing.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { isCommit, abort, banner, fileStamp } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

const CCA_ID = 95;
const EXPECT = "BakeRH's";
const RENAME_TO = "BakeRHs and Cooks";

async function main() {
  banner("rename-cca-95.mjs", COMMIT);

  const all = await db.cCA.findMany({ orderBy: { ccaID: "asc" } });
  const row = all.find((c) => c.ccaID === CCA_ID);

  if (!row) return abort(`no CCA with ccaID ${CCA_ID}.`);
  if (row.ccaName !== EXPECT) {
    console.error(`  BLOCK  ccaID ${CCA_ID} is named ${JSON.stringify(row.ccaName)}, not ${JSON.stringify(EXPECT)}`);
    console.error(`         (codepoints: ${[...row.ccaName].map((ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ")})`);
    return abort("the row does not hold the name this rename was written against.");
  }
  const clash = all.find((c) => c.ccaID !== CCA_ID && c.ccaName === RENAME_TO);
  if (clash) return abort(`ccaID ${clash.ccaID} is already named ${JSON.stringify(RENAME_TO)} — renaming would duplicate it.`);

  // What stays attached. Printed because "the references survive" is the whole
  // reason this is a rename, so it should be visible rather than asserted.
  const counts = {};
  for (const [coll, field] of [
    ["Bookings", "ccaID"],
    ["UserCCA", "ccaID"],
    ["CcaHead", "ccaID"],
    ["CcaProfile", "ccaID"],
    ["CcaApplication", "ccaID"],
    ["CcaInterviewSlot", "ccaID"],
    ["Posts", "ccaID"],
  ]) {
    const r = await db.$runCommandRaw({
      aggregate: coll,
      pipeline: [{ $match: { [field]: CCA_ID } }, { $count: "n" }],
      cursor: {},
    });
    const v = r?.cursor?.firstBatch?.[0]?.n;
    counts[coll] = typeof v === "object" ? Number(v.$numberInt ?? v.$numberLong ?? 0) : (v ?? 0);
  }

  console.log(`ccaID ${CCA_ID}  [${row.category}]`);
  console.log(`  ~ ${JSON.stringify(row.ccaName)}  ->  ${JSON.stringify(RENAME_TO)}`);
  console.log(`  = ccaID unchanged, so these stay attached: ${JSON.stringify(counts)}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.\n`);
    return;
  }

  const out = path.join(process.cwd(), "scripts", "remediation", "backups", `rename-cca-95-${fileStamp()}.json`);
  try {
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), before: row, to: RENAME_TO }, null, 2), "utf8");
    console.log(`\nBackup written: ${out}`);
  } catch (e) {
    return abort(`could not write the backup (${String(e?.message ?? e)}).`);
  }

  await db.cCA.update({ where: { ccaID: CCA_ID }, data: { ccaName: RENAME_TO } });

  console.log(`\n=== VERIFY ===`);
  const after = await db.cCA.findUnique({ where: { ccaID: CCA_ID } });
  console.log(`  ccaID ${CCA_ID} is now ${JSON.stringify(after?.ccaName)}`);
  if (after?.ccaName !== RENAME_TO) return abort("the rename did not take.");

  const names = (await db.cCA.findMany()).map((c) => c.ccaName);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  console.log(`  duplicate CCA names: ${dupes.length} ${dupes.length ? JSON.stringify([...new Set(dupes)]) : ""}`);
  if (dupes.length) return abort("the rename created a duplicate name.");

  console.log(`\nDone.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
