/**
 * Creates the INDEXES the AUX feature declares in prisma/schema.prisma
 * (AuxAward, AuxRecord, AuxRecordAttendee, and Event.auxYear), with the same
 * names, keys and uniqueness.
 *
 * DO NOT RUN `prisma db push` AGAINST THE CLUSTER INSTEAD OF THIS SCRIPT: a
 * push silently drops `User.email_unique_ci`. See create-transcript-indexes.mjs
 * and create-event-phase2-indexes.mjs for the history.
 *
 *   npx prisma generate                                      # types only
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *   node scripts/remediation/create-aux-indexes.mjs            # DRY RUN
 *   node scripts/remediation/create-aux-indexes.mjs --commit   # apply
 *   node scripts/remediation/index-census.mjs > census-after.txt
 *   diff census-before.txt census-after.txt
 *
 * The unique matters: without `auxRecordAttendee_pair` one resident can be
 * listed twice on a record-only event and earn 2 AUX for it. The others keep
 * the per-year tallies off a collection scan.
 *
 * On `Event` it adds ONE index (`event_auxYear`) and touches no other.
 *
 * Same engine as the transcript script (`apply`): dry run by default, never
 * drops or modifies an index, refuses on any conflict or existing duplicate,
 * then verifies by reading the indexes back. Touches ONLY the collections in
 * TARGETS. A Vitest test (src/server/api/services/__tests__/auxIndexes.test.ts)
 * fails if TARGETS and the schema differ.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { isCommit } from "./lib/rbac.mjs";
import { apply } from "./create-transcript-indexes.mjs";

export const TARGETS = {
  AuxAward: [
    {
      name: "auxAward_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: false,
    },
  ],
  AuxRecord: [
    { name: "auxRecord_year", key: { academicYear: 1 }, unique: false },
  ],
  AuxRecordAttendee: [
    {
      name: "auxRecordAttendee_pair",
      key: { recordID: 1, userID: 1 },
      unique: true,
    },
    {
      name: "auxRecordAttendee_year_user",
      key: { academicYear: 1, userID: 1 },
      unique: false,
    },
  ],
  Event: [{ name: "event_auxYear", key: { auxYear: 1 }, unique: false }],
};

async function main() {
  const db = new PrismaClient();
  try {
    await apply(db, isCommit(), TARGETS, {
      script: "create-aux-indexes.mjs",
      label: "AUX",
    });
  } finally {
    await db.$disconnect();
  }
}

// Run only when executed, so the test can import TARGETS.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then(() =>
      console.log(process.exitCode ? "\nAborted — see above." : "\nDone."),
    )
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
