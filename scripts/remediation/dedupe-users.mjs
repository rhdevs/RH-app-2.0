/**
 * #16 — Resolve duplicate-email accounts, then enforce email uniqueness.
 *
 * Because userID is derived from the email, duplicate emails are duplicate
 * accounts for the SAME person, and all dependent data (Bookings, Posts, Order,
 * …) references the userID STRING — which is identical across the duplicates —
 * so removing the extra User documents orphans nothing.
 *
 * This uses Prisma's connection (works wherever the app can reach the DB) and
 * runs in DRY_RUN mode by default:
 *
 *   node scripts/remediation/dedupe-users.mjs               # preview only
 *   DRY_RUN=false node scripts/remediation/dedupe-users.mjs # apply
 *
 * Keeper rule (per email group): prefer an account WITH a passwordHash, then the
 * most recently created, then lowest _id. Override by editing pickKeeper().
 *
 * In apply mode it deletes the non-keeper duplicates (Prisma cascades their
 * Session/Account rows) and then creates a CASE-INSENSITIVE unique index on
 * `email` (collation strength 2) — no schema field needed, and it doesn't touch
 * the validator-guarded User document shape.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const DRY = process.env.DRY_RUN !== "false";

function parseDate(v) {
  if (!v) return 0;
  if (typeof v === "object") {
    const d = v.$date ?? v;
    if (d && typeof d === "object" && d.$numberLong) return Number(d.$numberLong);
    return new Date(d).getTime() || 0;
  }
  return new Date(v).getTime() || 0;
}

function pickKeeper(docs) {
  return [...docs].sort((a, b) => {
    if (a.hasHash !== b.hasHash) return a.hasHash ? -1 : 1;
    const d = parseDate(b.createdAt) - parseDate(a.createdAt);
    if (d) return d;
    return a.id < b.id ? -1 : 1;
  })[0];
}

async function main() {
  const res = await db.$runCommandRaw({
    aggregate: "User",
    pipeline: [
      { $group: {
          _id: { $toLower: "$email" },
          n: { $sum: 1 },
          docs: { $push: {
            id: { $toString: "$_id" }, userID: "$userID", name: "$displayName",
            createdAt: "$createdAt",
            hasHash: { $cond: [{ $ifNull: ["$passwordHash", false] }, true, false] },
          } },
      } },
      { $match: { n: { $gt: 1 } } },
      { $sort: { n: -1 } },
    ],
    cursor: {},
  });
  const groups = res.cursor?.firstBatch ?? [];

  const toDelete = [];
  console.log(`Duplicate-email groups: ${groups.length}\n`);
  for (const g of groups) {
    const keeper = pickKeeper(g.docs);
    const del = g.docs.filter((d) => d.id !== keeper.id);
    toDelete.push(...del.map((d) => d.id));
    console.log(
      `  ${g._id}  keep=${keeper.userID}[${keeper.hasHash ? "pwd" : "no-pwd"}]  delete ${del.length}: ` +
        del.map((d) => `${d.userID}[${d.hasHash ? "pwd" : "no-pwd"}]`).join(", "),
    );
  }
  console.log(`\nAccounts to delete: ${toDelete.length}`);

  if (DRY) {
    console.log("\nDRY RUN — nothing changed. Re-run with DRY_RUN=false to apply.");
    return;
  }

  let deleted = 0;
  for (const id of toDelete) {
    await db.user.delete({ where: { id } });
    deleted++;
  }
  console.log(`Deleted ${deleted} duplicate user documents.`);

  await db.$runCommandRaw({
    createIndexes: "User",
    indexes: [{
      key: { email: 1 },
      name: "email_unique_ci",
      unique: true,
      collation: { locale: "en", strength: 2 },
    }],
  });
  console.log("Created case-insensitive unique index email_unique_ci on User.email.");
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
