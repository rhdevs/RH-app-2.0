/**
 * #18 — Normalize all monetary fields to integer CENTS so the schema can type
 * them as `Int` instead of `Json` (mixed Float/Int).
 *
 * ASSUMPTION: existing values are amounts in DOLLARS (e.g. 4 => $4.00,
 * 4.5 => $4.50). Each is converted with Math.round(value * 100).
 * ---> Review this assumption against your data before running for real. <---
 *
 * Requires the `mongodb` package and DATABASE_URL. Runs in DRY_RUN mode by
 * default (no writes); set DRY_RUN=false to apply:
 *
 *   node scripts/remediation/backfill-money-cents.mjs            # preview
 *   DRY_RUN=false node scripts/remediation/backfill-money-cents.mjs
 *
 * AFTER a successful real run, apply the schema patch in README.md (change the
 * affected `price` / cost fields from `Json` / `Float` to `Int`) and
 * `npx prisma generate`.
 */
import { MongoClient } from "mongodb";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const DRY_RUN = process.env.DRY_RUN !== "false";
const client = new MongoClient(url);

const toCents = (v) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : v;

/** Convert nested custom[].options[].price arrays in place. Returns true if changed. */
function convertCustomArray(custom) {
  let changed = false;
  if (!Array.isArray(custom)) return changed;
  for (const group of custom) {
    if (!group || !Array.isArray(group.options)) continue;
    for (const opt of group.options) {
      if (opt && typeof opt.price === "number") {
        opt.price = toCents(opt.price);
        changed = true;
      }
    }
  }
  return changed;
}

async function main() {
  await client.connect();
  const db = client.db();
  console.log(DRY_RUN ? "DRY RUN (no writes)\n" : "APPLYING CHANGES\n");

  // FoodMenu: price + custom[].options[].price
  await migrate(db, "FoodMenu", (doc) => {
    const set = {};
    if (typeof doc.price === "number") set.price = toCents(doc.price);
    const custom = doc.custom;
    if (convertCustomArray(custom)) set.custom = custom;
    return set;
  });

  // FoodOrder: foodPrice, price, custom[].options[].price, data.{foodPrice,price,custom}
  await migrate(db, "FoodOrder", (doc) => {
    const set = {};
    if (typeof doc.foodPrice === "number") set.foodPrice = toCents(doc.foodPrice);
    if (typeof doc.price === "number") set.price = toCents(doc.price);
    const custom = doc.custom;
    if (convertCustomArray(custom)) set.custom = custom;
    if (doc.data && typeof doc.data === "object") {
      const data = doc.data;
      if (typeof data.foodPrice === "number") data.foodPrice = toCents(data.foodPrice);
      if (typeof data.price === "number") data.price = toCents(data.price);
      convertCustomArray(data.custom);
      set.data = data;
    }
    return set;
  });

  // Order: totalCost
  await migrate(db, "Order", (doc) =>
    typeof doc.totalCost === "number" ? { totalCost: toCents(doc.totalCost) } : {},
  );

  // SupperGroup: currentFoodCost, totalPrice
  await migrate(db, "SupperGroup", (doc) => {
    const set = {};
    if (typeof doc.currentFoodCost === "number") set.currentFoodCost = toCents(doc.currentFoodCost);
    if (typeof doc.totalPrice === "number") set.totalPrice = toCents(doc.totalPrice);
    return set;
  });
}

async function migrate(db, collName, buildSet) {
  const coll = db.collection(collName);
  const cursor = coll.find({});
  let changed = 0;
  for await (const doc of cursor) {
    const set = buildSet(doc);
    if (Object.keys(set).length === 0) continue;
    changed++;
    if (!DRY_RUN) await coll.updateOne({ _id: doc._id }, { $set: set });
  }
  console.log(`${collName}: ${changed} document(s) ${DRY_RUN ? "would change" : "updated"}.`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => client.close());
