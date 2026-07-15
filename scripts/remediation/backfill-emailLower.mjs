/**
 * #16 — Populate a normalized `emailLower` on every User and add a unique index,
 * so email uniqueness is DB-enforced (case-insensitively).
 *
 * Uses the raw MongoDB driver to avoid Prisma validation while the schema field
 * doesn't exist yet. Requires the `mongodb` package (`npm i -D mongodb`) and
 * DATABASE_URL in the environment.
 *
 *   node scripts/remediation/backfill-emailLower.mjs
 *
 * After it succeeds, add `emailLower String? @unique` to the User model in
 * schema.prisma and run `npx prisma generate` (NOT `db push` for the index —
 * this script already created it as a sparse unique index).
 */
import { MongoClient } from "mongodb";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = new MongoClient(url);

async function main() {
  await client.connect();
  const db = client.db();
  const users = db.collection("User");

  const cursor = users.find({}, { projection: { email: 1 } });
  let updated = 0;
  const seen = new Map(); // emailLower -> _id, to detect duplicates
  const duplicates = [];

  for await (const u of cursor) {
    if (!u.email) continue;
    const lower = String(u.email).toLowerCase();
    if (seen.has(lower)) {
      duplicates.push({ email: u.email, _id: u._id, conflictsWith: seen.get(lower) });
      continue;
    }
    seen.set(lower, u._id);
    await users.updateOne({ _id: u._id }, { $set: { emailLower: lower } });
    updated++;
  }

  console.log(`Set emailLower on ${updated} users.`);
  if (duplicates.length) {
    console.warn(
      `\nWARNING: ${duplicates.length} duplicate emails found. Resolve these ` +
        `before the unique index can be created:\n`,
      duplicates,
    );
    return;
  }

  // Sparse + unique so any users still missing the field don't collide.
  await users.createIndex(
    { emailLower: 1 },
    { unique: true, sparse: true, name: "emailLower_unique" },
  );
  console.log("Created unique index emailLower_unique.");
}

main()
  .then(() => console.log("emailLower backfill complete."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => client.close());
