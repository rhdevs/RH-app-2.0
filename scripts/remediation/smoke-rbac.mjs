/**
 * Doc 01 Step 15 smoke tests. READ-ONLY.
 *
 *   node scripts/remediation/smoke-rbac.mjs
 *
 * Confirms the two things `prisma validate` cannot: that Prisma 6.10 actually
 * supports `@@index` on a scalar list for MongoDB and that `roles: { has: X }`
 * filters work against it. Both are load-bearing — 02-backend-authz.md's
 * last-admin guard and 03-admin-dashboard.md's role filter depend on `has`.
 *
 * If `has` misbehaves, this script says so and the documented fallback is an
 * in-memory filter over the (small) UserRole collection. It cross-checks every
 * typed `has` count against a raw $runCommandRaw aggregation over the same
 * collection, so a silently-wrong `has` is caught rather than trusted.
 *
 * It also asserts the STILL-DEPLOYED client can read both collections — the
 * I-2 regression guard after the seed and the resident backfill.
 */
import { PrismaClient } from "@prisma/client";
import { countWhere, ROLE_VOCAB } from "./lib/rbac.mjs";

const db = new PrismaClient();
let failed = 0;
const fail = (m) => { console.error(`  FAIL  ${m}`); failed++; };

async function main() {
  console.log(`\n=== smoke-rbac.mjs (READ-ONLY) ===\n`);

  // [1] I-2 regression guard: an UNPROJECTED typed read of both collections.
  //     This is the exact read the session callback and access.ts perform. If a
  //     required scalar is missing on any document, Prisma throws HERE — which
  //     is the whole point of running it.
  console.log(`[1] typed reads (I-2 guard — the deployed client must read cleanly)`);
  try {
    const ur = await db.userRole.findMany();
    const fa = await db.facilityAccess.findMany();
    console.log(`  UserRole rows readable:       ${ur.length}`);
    console.log(`  FacilityAccess rows readable: ${fa.length}`);
    console.log(`  every FacilityAccess legacy scalar is a string or null: ` +
      `${fa.every((r) => r.requiredRole === null || typeof r.requiredRole === "string")}`);
  } catch (e) {
    fail(`typed read THREW — a document is missing a required scalar (I-2). ${e.message}`);
  }

  // [2] multikey `has` filter, cross-checked against a raw aggregation.
  console.log(`\n[2] roles multikey \`has\` filter vs. a raw aggregation`);
  for (const role of ROLE_VOCAB) {
    let typed = null;
    try { typed = await db.userRole.count({ where: { roles: { has: role } } }); }
    catch (e) { fail(`\`has\` threw for "${role}": ${e.message}`); continue; }
    const rawCount = await countWhere(db, "UserRole", { roles: role });
    const agree = typed === rawCount;
    console.log(`  ${role.padEnd(10)} has=${String(typed).padStart(4)}  raw=${String(rawCount).padStart(4)}  ${agree ? "agree" : "DISAGREE"}`);
    if (!agree) {
      fail(`\`roles: { has: "${role}" }\` returned ${typed} but the raw query returned ${rawCount}. ` +
        `Do NOT rely on \`has\` — fall back to an in-memory filter in the last-admin guard ` +
        `and the /admin role filter.`);
    }
  }

  // [3] The expected shape after Phase 1.
  console.log(`\n[3] expected counts`);
  const admins = await countWhere(db, "UserRole", { roles: "admin" });
  const jcrc = await countWhere(db, "UserRole", { roles: "jcrc" });
  const resident = await countWhere(db, "UserRole", { roles: "resident" });
  console.log(`  admin:    ${admins}   (expect 1)`);
  console.log(`  jcrc:     ${jcrc}   (expect your roster size, e.g. 11)`);
  console.log(`  resident: ${resident}   (expect the eligible count from backfill-resident.mjs)`);
  if (admins === 0) fail(`ZERO admins. Nobody can reach /admin. Re-run seed-roles-v2.mjs.`);

  console.log(`\n================================`);
  if (failed) { console.error(`${failed} smoke failure(s).`); process.exitCode = 1; return; }
  console.log(`All smoke checks passed.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
