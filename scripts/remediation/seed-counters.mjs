/**
 * Seeds the `bookingID` counter to the current maximum so allocation never
 * collides with an existing booking.
 *
 *   node scripts/remediation/seed-counters.mjs            # dry run (default)
 *   node scripts/remediation/seed-counters.mjs --commit   # apply
 *
 * PROVENANCE. This logic was seed-rbac.mjs:55-66 and NOTHING else in the plan
 * carries it: grepping 01-data-model.md for `bookingID` / `counter` returns
 * nothing, so retiring seed-rbac.mjs without moving this block would lose the
 * only record of how the booking-id counter is initialised (doc 06 §5 step 2).
 *
 * Idempotent by construction: `update: {}` means an existing counter is never
 * touched, so a re-run can never rewind a counter that has advanced past the
 * current max. That property is load-bearing — do not "improve" it into a
 * $max/$set.
 */
import { PrismaClient } from "@prisma/client";
import { isCommit, banner, numify } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

async function main() {
  banner("seed-counters.mjs", COMMIT);

  const last = await db.bookings.findFirst({ orderBy: { bookingID: "desc" }, select: { bookingID: true } });
  const seq = numify(last?.bookingID);

  const existing = await db.counter.findUnique({ where: { key: "bookingID" } });
  console.log(`max Bookings.bookingID:      ${seq}`);
  console.log(`existing Counter.bookingID:  ${existing ? existing.seq : "(absent)"}`);

  if (existing) {
    console.log(`\nCounter already exists — this script leaves it ALONE (update: {}).`);
    if (numify(existing.seq) < seq) {
      console.warn(`  ! WARNING: the counter (${existing.seq}) is BELOW the max bookingID (${seq}).`);
      console.warn(`    The next allocation would collide. This script deliberately will not`);
      console.warn(`    fix that silently — investigate why the counter fell behind first.`);
      process.exitCode = 1;
    }
    return;
  }

  console.log(`\n  ${COMMIT ? "+" : "~"} create Counter{ key: "bookingID", seq: ${seq} }`);
  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    return;
  }
  await db.counter.upsert({
    where: { key: "bookingID" },
    create: { key: "bookingID", seq },
    update: {},
  });
  const after = await db.counter.findUnique({ where: { key: "bookingID" } });
  console.log(`\n=== VERIFY ===`);
  console.log(`Counter.bookingID: ${after?.seq ?? "(ABSENT — write failed)"}`);
  if (!after) process.exitCode = 1;
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
