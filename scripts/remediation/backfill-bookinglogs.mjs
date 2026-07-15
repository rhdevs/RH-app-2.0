/**
 * #19 — Normalize BookingLogs so the schema can use strict scalar types instead
 * of Json for bookingID / bookUntil / forceBook, and collapse the duplicate
 * forceBook (Json) + forceBooking (Boolean) pair into a single Boolean forceBook.
 *
 *   node scripts/remediation/backfill-bookinglogs.mjs            # preview
 *   DRY_RUN=false node scripts/remediation/backfill-bookinglogs.mjs
 *
 * Conversions:
 *   bookingID:  "123" | 123      -> Int (123)
 *   bookUntil:  Int | BigInt     -> Int
 *   forceBook:  Boolean | Int(0/1) + forceBooking(Boolean) -> single Boolean
 *
 * AFTER a real run, apply the schema patch in README.md and `npx prisma generate`.
 */
import { MongoClient } from "mongodb";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const DRY_RUN = process.env.DRY_RUN !== "false";
const client = new MongoClient(url);

const toInt = (v) => {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Math.trunc(Number(v));
  }
  return undefined;
};

const toBool = (v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return undefined;
};

async function main() {
  await client.connect();
  const db = client.db();
  const coll = db.collection("BookingLogs");
  console.log(DRY_RUN ? "DRY RUN (no writes)\n" : "APPLYING CHANGES\n");

  const cursor = coll.find({});
  let changed = 0;
  for await (const doc of cursor) {
    const set = {};
    const unset = {};

    const bid = toInt(doc.bookingID);
    if (bid !== undefined && bid !== doc.bookingID) set.bookingID = bid;

    const bu = toInt(doc.bookUntil);
    if (bu !== undefined && bu !== doc.bookUntil) set.bookUntil = bu;

    // Prefer explicit forceBook, fall back to legacy forceBooking.
    const fb = toBool(doc.forceBook) ?? toBool(doc.forceBooking);
    if (fb !== undefined && (typeof doc.forceBook !== "boolean" || doc.forceBook !== fb)) {
      set.forceBook = fb;
    }
    if ("forceBooking" in doc) unset.forceBooking = "";

    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) continue;
    changed++;
    if (!DRY_RUN) {
      const update = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;
      await coll.updateOne({ _id: doc._id }, update);
    }
  }
  console.log(`BookingLogs: ${changed} document(s) ${DRY_RUN ? "would change" : "updated"}.`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => client.close());
