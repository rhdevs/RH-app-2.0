/**
 * Creates the two INDEXES the equipment-loan collection needs, the two that
 * prisma/schema.prisma declares for `EquipmentLoan`:
 * `equipment_loan_event` (a loan list for one event) and
 * `equipment_loan_status_collect` (the board and the overdue check, by status
 * and collection time). Neither is unique. `EquipmentItem` has no index
 * besides `_id_`.
 *
 * DO NOT RUN `prisma db push` AGAINST THE CLUSTER INSTEAD OF THIS SCRIPT: a
 * push silently drops `User.email_unique_ci` and this stack's partial unique
 * indexes (`notification_notice_key`, `disposable_request_proposal_unique`).
 * See create-transcript-indexes.mjs for the history. For this feature run
 * `npx prisma generate` only, then this script.
 *
 *   npx prisma generate                                              # types only
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *   node scripts/remediation/create-equipment-indexes.mjs            # DRY RUN
 *   node scripts/remediation/create-equipment-indexes.mjs --commit   # apply
 *   node scripts/remediation/index-census.mjs > census-after.txt
 *   diff census-before.txt census-after.txt
 *
 * ONLY THEN set `equipment.enabled` to "on". The census after must show both
 * indexes named below. Run it BEFORE the flag.
 *
 * Same engine as the transcript script (`apply`): dry run by default (it
 * prints the database it would write to and the plan, and writes nothing),
 * never drops or modifies an index, refuses on any conflict, and is
 * idempotent: a second run finds everything present and writes nothing. It
 * then verifies by reading the indexes back. Touches ONLY the collections in
 * TARGETS. A Vitest test (src/server/api/services/__tests__/
 * equipmentIndexes.test.ts) fails if TARGETS and the schema differ.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { isCommit } from "./lib/rbac.mjs";
import { apply } from "./create-transcript-indexes.mjs";

export const TARGETS = {
  EquipmentLoan: [
    {
      name: "equipment_loan_event",
      key: { eventID: 1 },
      unique: false,
    },
    {
      name: "equipment_loan_status_collect",
      key: { status: 1, collectAt: 1 },
      unique: false,
    },
  ],
};

async function main() {
  const db = new PrismaClient();
  try {
    await apply(db, isCommit(), TARGETS, {
      script: "create-equipment-indexes.mjs",
      label: "equipment",
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
