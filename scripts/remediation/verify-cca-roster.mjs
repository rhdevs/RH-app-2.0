/**
 * CCA roster resolution — pre-flight and drift census. READ-ONLY.
 *
 *   node scripts/remediation/verify-cca-roster.mjs            # all CCAs
 *   node scripts/remediation/verify-cca-roster.mjs --cca 12   # one CCA, verbose
 *
 * TOUCHES THE DATABASE: reads only. No write, no index build, no delete.
 *
 * GATES the assumptions src/server/api/services/ccaRoster.ts is built on. It is
 * deliberately NOT a "drift must be zero" check — drift is EXPECTED here, and
 * the UI surfaces it in amber on purpose. It exits non-zero only for the things
 * that make a roster WRONG rather than merely incomplete.
 *
 * RUN THIS BEFORE TRUSTING THE ROSTER. Checks [1] and [4] can invalidate the
 * resolver's design; learning that from this script costs an hour, learning it
 * from the UI costs a week.
 *
 * EXIT CODES
 *   0  assumptions hold. Drift counts printed as warnings.
 *   1  a BLOCKING assumption failed:
 *      [1] findRaw scalar-vs-array matching disagrees with $elemMatch
 *      [2] an unprojected typed read threw (I-2 regression)
 *      [4] a membership key is claimed by >1 User row (attribution hazard)
 *      [6] a CcaHead key is not a canonical userID (I-1)
 *      [10] a CCA row holds the RESERVED ccaID 0 (cascade.ts / 07 §5)
 *   2  could not connect, or an unexpected throw.
 */
import { PrismaClient } from "@prisma/client";
import { countWhere, aggregateAll } from "./lib/rbac.mjs";
import { canonicalUserID, isCanonicalResidentID } from "./lib/identity.mjs";

const db = new PrismaClient();
let failed = 0;
const fail = (m) => {
  console.error(`  FAIL  ${m}`);
  failed++;
};
const warn = (m) => console.log(`  warn  ${m}`);

const onlyCca = (() => {
  const i = process.argv.indexOf("--cca");
  return i === -1 ? null : Number(process.argv[i + 1]);
})();

async function main() {
  console.log(`\n=== verify-cca-roster.mjs (READ-ONLY) ===\n`);

  /* [1] THE LOAD-BEARING MONGO SEMANTIC ----------------------------------- */
  // ccaRoster.ts reads the embedded User.userCCA array with
  // findRaw({ filter: { userCCA: ccaID } }), relying on Mongo matching a scalar
  // element-wise against an array field. `userCCA` is not declared in
  // `model User`, so nothing else in the codebase asserts this. If it is ever
  // false, Source A silently returns nothing and rosters under-report with no
  // error anywhere.
  console.log(`[1] findRaw scalar-vs-array matching (blocking)`);
  const sampleCcas = await db.cCA.findMany({
    select: { ccaID: true },
    orderBy: { ccaID: "asc" },
    take: 5,
  });
  for (const { ccaID } of sampleCcas) {
    const plain = await countWhere(db, "User", { userCCA: ccaID });
    const elem = await countWhere(db, "User", {
      userCCA: { $elemMatch: { $eq: ccaID } },
    });
    const agree = plain === elem;
    console.log(
      `  ccaID ${String(ccaID).padStart(4)}  scalar=${String(plain).padStart(4)}  $elemMatch=${String(elem).padStart(4)}  ${agree ? "agree" : "DISAGREE"}`,
    );
    if (!agree) {
      fail(
        `{ userCCA: ${ccaID} } returned ${plain} but $elemMatch returned ${elem}. ` +
          `ccaRoster.ts Source A is unsound — switch it to $elemMatch.`,
      );
    }
  }

  /* [2] I-2 REGRESSION GUARD ---------------------------------------------- */
  console.log(`\n[2] unprojected typed reads (I-2 guard, blocking)`);
  try {
    const ccas = await db.cCA.findMany();
    const uc = await db.userCCA.findMany();
    const ch = await db.ccaHead.findMany();
    console.log(`  CCA:     ${ccas.length}`);
    console.log(`  UserCCA: ${uc.length}`);
    console.log(`  CcaHead: ${ch.length}`);
  } catch (e) {
    fail(
      `a typed read THREW — a document is missing a required scalar (I-2). ${e.message}`,
    );
  }

  /* [3] KEY FORMAT CENSUS -------------------------------------------------- */
  console.log(`\n[3] UserCCA.userID format census`);
  const allUserCca = await db.userCCA.findMany({
    select: { ccaID: true, userID: true },
  });
  const eFmt = allUserCca.filter((r) => /^E\d{7}$/i.test(r.userID)).length;
  const aFmt = allUserCca.filter((r) => /^A\d{7}[A-Z]$/i.test(r.userID)).length;
  console.log(`  total rows: ${allUserCca.length}`);
  console.log(`  E-format:   ${eFmt}`);
  console.log(`  A-format:   ${aFmt}`);
  console.log(`  other:      ${allUserCca.length - eFmt - aFmt}`);
  const perCca = new Map();
  for (const r of allUserCca)
    perCca.set(r.ccaID, (perCca.get(r.ccaID) ?? 0) + 1);
  const maxRows = Math.max(0, ...perCca.values());
  console.log(`  max rows for one CCA: ${maxRows}`);
  if (aFmt > 0) {
    warn(
      `mixed key formats confirmed. @@unique([ccaID,userID]) stays DEFERRED ` +
        `(07 §0.3); @@index([ccaID]) alone is still safe to add.`,
    );
  }

  /* [4] AMBIGUOUS KEYS — THE ATTRIBUTION HAZARD ---------------------------- */
  // If one membership key is claimed by two User rows, any resolver that picks
  // the first attributes one person's membership to another — a failure
  // indistinguishable from success. ccaRoster.ts refuses to pick; this check
  // reports whether the situation exists at all.
  console.log(`\n[4] membership keys claimed by >1 User row (blocking)`);
  const keys = [
    ...new Set([
      ...allUserCca.map((r) => r.userID),
      ...(await db.ccaHead.findMany({ select: { userID: true } })).map(
        (r) => r.userID,
      ),
    ]),
  ].filter(Boolean);

  const users = await db.user.findMany({
    select: { id: true, email: true, userID: true },
  });
  const claims = new Map();
  const claim = (k, id) => {
    if (!k) return;
    const s = claims.get(k) ?? new Set();
    s.add(id);
    claims.set(k, s);
  };
  for (const u of users) {
    claim(canonicalUserID(u.email), u.id);
    if (u.userID) claim(u.userID, u.id);
  }

  let ambiguous = 0;
  let unresolvable = 0;
  for (const k of keys) {
    const c = claims.get(k);
    if (!c || c.size === 0) unresolvable++;
    else if (c.size > 1) {
      ambiguous++;
      fail(
        `key "${k}" is claimed by ${c.size} User rows (${[...c].join(", ")}). ` +
          `Merge the duplicates — see scripts/remediation/dedupe-users.mjs.`,
      );
    }
  }
  console.log(`  distinct membership keys: ${keys.length}`);
  console.log(`  ambiguous:                ${ambiguous}`);
  console.log(`  unresolvable:             ${unresolvable}`);
  if (unresolvable > 0) {
    warn(
      `${unresolvable} key(s) match no account. These render AMBER in the ` +
        `roster and are not dropped — expected, not a failure.`,
    );
  }

  /* [5] DUPLICATE MEMBERSHIP ROWS ------------------------------------------ */
  console.log(`\n[5] duplicate (ccaID, userID) pairs`);
  const seen = new Set();
  const dups = [];
  for (const r of allUserCca) {
    const k = `${r.ccaID}|${r.userID}`;
    if (seen.has(k)) dups.push(k);
    seen.add(k);
  }
  console.log(`  duplicates: ${dups.length}`);
  if (dups.length > 0) {
    warn(`e.g. ${dups.slice(0, 5).join(", ")}`);
    warn(
      `the roster collapses these into one row with a count. @@unique is ` +
        `blocked until they are deduped.`,
    );
  }

  /* [6] I-1 — CcaHead KEYS ARE CANONICAL ----------------------------------- */
  // NOT an E-format assertion: "G.S_SAMUEL" is a real canonical key here, and
  // asserting /^E\d{7}$/ is lockout mode L-27.
  console.log(`\n[6] CcaHead.userID is canonical (I-1, blocking)`);
  const headRows = await db.ccaHead.findMany({
    select: { userID: true, ccaID: true },
  });
  let badKeys = 0;
  for (const h of headRows) {
    if (!isCanonicalResidentID(h.userID)) {
      badKeys++;
      fail(`CcaHead row for ccaID ${h.ccaID} has non-canonical userID "${h.userID}"`);
    }
  }
  console.log(`  head rows: ${headRows.length}, non-canonical: ${badKeys}`);

  /* [7] HEADS THAT RESOLVE TO NO ACCOUNT ----------------------------------- */
  console.log(`\n[7] heads with no matching account`);
  const orphanHeads = headRows.filter((h) => !claims.get(h.userID)?.size);
  console.log(`  ${orphanHeads.length}`);
  if (orphanHeads.length > 0) {
    warn(
      `these render amber WITH a Head pill: ` +
        `${orphanHeads.slice(0, 5).map((h) => h.userID).join(", ")}`,
    );
  }

  /* [8] CH-1 DRIFT, BOTH DIRECTIONS ---------------------------------------- */
  console.log(`\n[8] CH-1 (cca_head string <-> CcaHead row)`);
  const stringWithoutScope = await aggregateAll(db, "UserRole", [
    { $match: { roles: "cca_head" } },
    {
      $lookup: {
        from: "CcaHead",
        localField: "userID",
        foreignField: "userID",
        as: "h",
      },
    },
    { $match: { h: { $size: 0 } } },
    { $project: { userID: 1 } },
  ]);
  const scopeWithoutString = await aggregateAll(db, "CcaHead", [
    {
      $lookup: {
        from: "UserRole",
        localField: "userID",
        foreignField: "userID",
        as: "r",
      },
    },
    { $match: { "r.roles": { $ne: "cca_head" } } },
    { $project: { userID: 1, ccaID: 1 } },
  ]);
  console.log(`  string without scope: ${stringWithoutScope.length}`);
  console.log(`  scope without string: ${scopeWithoutString.length}`);
  if (stringWithoutScope.length > 0) {
    warn(
      `these users reach /cca and see an EMPTY list — the intended failure ` +
        `direction, but the string should be revoked.`,
    );
  }

  /* [9] ORPHANED HEADSHIPS ------------------------------------------------- */
  console.log(`\n[9] CcaHead rows pointing at a deleted CCA`);
  const liveCcaIDs = new Set(
    (await db.cCA.findMany({ select: { ccaID: true } })).map((c) => c.ccaID),
  );
  const orphanScope = headRows.filter((h) => !liveCcaIDs.has(h.ccaID));
  console.log(`  ${orphanScope.length}`);
  if (orphanScope.length > 0) {
    warn(
      `deleteCcaCascade now removes CcaHead rows, so these predate that fix.`,
    );
  }

  /* [10] THE RESERVED ccaID ------------------------------------------------ */
  // BookingModal hardcodes ccaID 0 on every booking, and deleteCcaCascade
  // deletes bookings by ccaID. A CCA row holding 0 is a live hazard even with
  // the guard in place, because the guard makes it undeletable rather than safe.
  console.log(`\n[10] reserved ccaID 0 (blocking)`);
  const zero = await db.cCA.findFirst({ where: { ccaID: 0 } });
  if (zero) {
    fail(
      `a CCA row holds the RESERVED ccaID 0: ${JSON.stringify(zero)}. ` +
        `Re-key it before anything else — every booking created by the current ` +
        `UI carries ccaID 0.`,
    );
  } else {
    console.log(`  none — good`);
  }

  /* [11] INDEX REPORT ------------------------------------------------------ */
  console.log(`\n[11] UserCCA index report`);
  try {
    const probe = onlyCca ?? sampleCcas[0]?.ccaID;
    const t0 = Date.now();
    await db.userCCA.findMany({ where: { ccaID: probe } });
    const ms = Date.now() - t0;
    const idx = await db.$runCommandRaw({ listIndexes: "UserCCA" });
    const names = (idx?.cursor?.firstBatch ?? []).map((i) => i.name);
    console.log(`  indexes: ${names.join(", ") || "(none)"}`);
    console.log(`  roster read for ccaID ${probe}: ${ms}ms`);
    if (!names.some((n) => n.toLowerCase().includes("ccaid"))) {
      warn(
        `no ccaID index — roster reads are a COLLSCAN. Safe to add ` +
          `@@index([ccaID]) (non-unique, so duplicates do not block it).`,
      );
    }
  } catch (e) {
    warn(`index report unavailable: ${e.message}`);
  }

  console.log(
    `\n=== ${failed === 0 ? "PASS" : `FAIL (${failed} blocking)`} ===\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(`\nUNEXPECTED: ${e?.stack ?? e}\n`);
    process.exit(2);
  })
  .finally(() => db.$disconnect());
