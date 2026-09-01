/**
 * Marks a facility as NOT BOOKABLE THROUGH RHAPP (or restores it), by writing
 * `FacilityAccess.bookable` and `FacilityAccess.unbookableNote`.
 *
 *   node scripts/remediation/set-facility-bookable.mjs                        # list current state
 *   node scripts/remediation/set-facility-bookable.mjs 17 off --commit        # close facility 17
 *   node scripts/remediation/set-facility-bookable.mjs 17 on  --commit        # reopen it
 *   node scripts/remediation/set-facility-bookable.mjs 17 off --note "..."  --commit
 *
 * WHAT THIS REPLACES. The Dance Studio rule used to be two lines in
 * `BookingModal.tsx`:
 *
 *     selectedFacility === "Dance Studio"      // a red note
 *     disabled={... || selectedFacility === "Dance Studio"}
 *
 * Matched on the DISPLAY NAME, in the browser, with NO server-side equivalent.
 * It would have stopped working silently the day anyone renamed the room, and a
 * request that never loaded that component was never subject to it at all. The
 * flag this script writes is read by `evaluateBookingWithMode`, which is the
 * enforcement point for both `createBooking` and `updateBooking`.
 *
 * ---------------------------------------------------------------------------
 * NO `prisma db push` IS REQUIRED, AND IT MUST NOT BE RUN
 * ---------------------------------------------------------------------------
 *
 * This adds FIELDS to an existing Mongo collection, and Mongo is schemaless —
 * `npx prisma generate` is the whole schema step. `db push` would additionally
 * DROP `User.email_unique_ci`, the collation index that is the duplicate-account
 * guard, because Prisma cannot represent a collation index and therefore treats
 * it as not-in-schema. It has been dropped and restored on this cluster before.
 *
 * ---------------------------------------------------------------------------
 * THE VALIDATOR PRE-FLIGHT IS THE FIRST THING THIS DOES, AND IT CAN REFUSE
 * ---------------------------------------------------------------------------
 *
 * `FacilityAccess` is BELIEVED to carry no `$jsonSchema` validator —
 * schema.prisma says it was created precisely BECAUSE the `Facilities`
 * collection is validated, and `Facilities` carries the Prisma introspection
 * marker while `FacilityAccess` does not. That is strong evidence and it is not
 * proof: only the live cluster counts.
 *
 * IT MATTERS BECAUSE A `$jsonSchema` REJECTION ARRIVES AS DATA, NOT AS A THROW.
 * A validator that enumerates permitted properties rejects a write carrying an
 * undeclared `bookable` with `{ ok: 1, writeErrors: [{ code: 121 }] }`. A caller
 * that only inspects the catch block sees SUCCESS — so the flag would appear to
 * be set, the room would stay bookable, and nothing anywhere would say why. The
 * same trap is documented in services/roles.ts (I-8f) and merge-by-canonical.mjs.
 *
 * So this script reads the collection's validator before it writes, prints it,
 * and REFUSES to commit if one exists that could reject the new fields.
 */
import { PrismaClient } from "@prisma/client";
import { isCommit, banner } from "./lib/rbac.mjs";

const COLL = "FacilityAccess";
const db = new PrismaClient();
const COMMIT = isCommit();

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const facilityID = positional[0] !== undefined ? Number(positional[0]) : null;
const desired = positional[1]; // "on" | "off"

const noteIdx = argv.indexOf("--note");
const note = noteIdx >= 0 ? argv[noteIdx + 1] : undefined;

const DEFAULT_NOTE =
  "This room can't be booked through RHApp. Please approach the CCA Exco that manages it.";

/** Read the live collection validator. `null` is the expected, safe answer. */
async function readValidator() {
  try {
    const reply = await db.$runCommandRaw({
      listCollections: 1,
      filter: { name: COLL },
    });
    const batch = reply?.cursor?.firstBatch ?? [];
    if (batch.length === 0) return { exists: false, validator: null };
    return {
      exists: true,
      validator: batch[0]?.options?.validator ?? null,
    };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

async function main() {
  banner("set-facility-bookable", COMMIT);

  /* ---- PRE-FLIGHT ------------------------------------------------------ */
  const v = await readValidator();
  if (v.error) {
    console.error(`\n*** could not read the ${COLL} validator: ${v.error} ***`);
    console.error(`Refusing to write blind. Fix connectivity and re-run.\n`);
    process.exitCode = 1;
    return;
  }
  if (!v.exists) {
    console.log(
      `  [preflight] ${COLL} does not exist yet — it will be created on first write.`,
    );
  } else if (v.validator === null) {
    console.log(`  [preflight] ${COLL} validator: none (expected)`);
  } else {
    console.error(`\n*** ${COLL} CARRIES A $jsonSchema VALIDATOR ***`);
    console.error(JSON.stringify(v.validator, null, 2));
    console.error(
      `\nA write carrying \`bookable\` / \`unbookableNote\` may be rejected with code 121,`,
    );
    console.error(
      `and that rejection arrives as DATA rather than a throw — it would look like success.`,
    );
    console.error(
      `Add both properties to the validator with collMod first, then re-run.\n`,
    );
    process.exitCode = 1;
    return;
  }

  /* ---- CURRENT STATE --------------------------------------------------- */
  const [facilities, rows] = await Promise.all([
    db.facilities.findMany({ orderBy: { facilityID: "asc" } }),
    db.facilityAccess.findMany(),
  ]);
  const byId = new Map(rows.map((r) => [r.facilityID, r]));

  const closed = facilities.filter(
    (f) => byId.get(f.facilityID)?.bookable === false,
  );
  console.log(`\n  ${facilities.length} facilities, ${closed.length} closed:`);
  for (const f of closed) {
    console.log(
      `    [${f.facilityID}] ${f.facilityName} — ${byId.get(f.facilityID)?.unbookableNote ?? "(no note)"}`,
    );
  }
  if (closed.length === 0) console.log(`    (none)`);

  if (facilityID === null || desired === undefined) {
    console.log(
      `\nPass a facilityID and \`on\`/\`off\` to change one. Facilities:\n`,
    );
    for (const f of facilities) {
      console.log(
        `    [${String(f.facilityID).padStart(3)}] ${f.facilityName} — ${f.facilityLocation}`,
      );
    }
    console.log("");
    return;
  }

  if (desired !== "on" && desired !== "off") {
    console.error(`\n*** second argument must be "on" or "off" ***\n`);
    process.exitCode = 1;
    return;
  }

  const target = facilities.find((f) => f.facilityID === facilityID);
  if (!target) {
    console.error(`\n*** no facility with facilityID ${facilityID} ***\n`);
    process.exitCode = 1;
    return;
  }

  const bookable = desired === "on";
  console.log(
    `\n  ${bookable ? "REOPEN" : "CLOSE"}  [${target.facilityID}] ${target.facilityName}`,
  );
  if (!bookable) console.log(`  note: ${note ?? DEFAULT_NOTE}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.\n`);
    return;
  }

  // An UPSERT: a facility with no FacilityAccess row is the majority case under
  // D-1, and closing one must not require it to have been configured first.
  // `requiredRoles` is left at its default on create and UNTOUCHED on update —
  // this script owns exactly two fields and must never disturb the role config.
  await db.facilityAccess.upsert({
    where: { facilityID },
    create: {
      facilityID,
      bookable,
      unbookableNote: bookable ? null : (note ?? DEFAULT_NOTE),
      updatedAt: new Date(),
      updatedBy: "set-facility-bookable.mjs",
    },
    update: {
      bookable,
      unbookableNote: bookable ? null : (note ?? DEFAULT_NOTE),
      updatedAt: new Date(),
      updatedBy: "set-facility-bookable.mjs",
    },
  });

  // READ IT BACK. The whole point of the pre-flight above is that a rejected
  // write can look like a successful one; the only way to be sure is to ask.
  const after = await db.facilityAccess.findUnique({ where: { facilityID } });
  if (after?.bookable !== bookable) {
    console.error(
      `\n*** WRITE DID NOT TAKE — bookable reads back as ${String(after?.bookable)} ***`,
    );
    console.error(
      `This is what a silently-rejected validator write looks like. Do not assume it worked.\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n  confirmed: bookable=${String(after.bookable)} note=${after.unbookableNote ?? "(none)"}\n`,
  );
}

main()
  .catch((e) => {
    console.error(`\n*** UNCAUGHT: ${String(e?.message ?? e)} ***`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
