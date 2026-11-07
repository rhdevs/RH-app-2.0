/**
 * Creates the INDEXES the disposable-request collection needs: the two the
 * schema declares in prisma/schema.prisma for `DisposableRequest`, plus ONE
 * index Prisma cannot express and that is therefore NOT in the schema:
 * `disposable_request_proposal_unique`, a PARTIAL unique index on `proposalID`
 * (only rows whose link is a non-empty string). One proposal has at most one
 * disposable request; requests with no proposal are outside the index, so they
 * never collide on null. Declared in the schema it would be a plain unique
 * index and every unlinked request would collide.
 *
 * The name says "reminder" because the reminder collections (ReminderBroadcast
 * and ReminderTarget, PR 14) are added to the SAME TARGETS map below, so one
 * script and one drift test cover the whole feature.
 *
 * DO NOT RUN `prisma db push` AGAINST THE CLUSTER INSTEAD OF THIS SCRIPT: a
 * push silently drops `User.email_unique_ci`. See create-transcript-indexes.mjs
 * for the history.
 *
 *   npx prisma generate                                                   # types only
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *   node scripts/remediation/create-disposable-reminder-indexes.mjs          # DRY RUN
 *   node scripts/remediation/create-disposable-reminder-indexes.mjs --commit # apply
 *   node scripts/remediation/index-census.mjs > census-after.txt
 *   diff census-before.txt census-after.txt
 *
 * ONLY THEN set `disposables.enabled` to "on". The census after must show every
 * index named below; the doctor goes RED if the flag is on and one is missing.
 *
 * Same engine as the transcript script (`apply`): dry run by default, never
 * drops or modifies an index, refuses on any conflict or existing duplicate,
 * then verifies by reading the indexes back. Touches ONLY the collections in
 * TARGETS. A Vitest test (src/server/api/services/__tests__/
 * disposableIndexes.test.ts) fails if TARGETS and the schema differ.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { isCommit } from "./lib/rbac.mjs";
import { apply } from "./create-transcript-indexes.mjs";

export const TARGETS = {
  DisposableRequest: [
    {
      name: "disposable_request_cca_day",
      key: { ccaID: 1, collectionDay: 1 },
      unique: false,
    },
    {
      name: "disposable_request_status_day",
      key: { status: 1, collectionDay: 1 },
      unique: false,
    },
    {
      name: "disposable_request_proposal_unique",
      key: { proposalID: 1 },
      unique: true,
      partialFilterExpression: { proposalID: { $gt: "" } },
    },
  ],
};

async function main() {
  const db = new PrismaClient();
  try {
    await apply(db, isCommit(), TARGETS, {
      script: "create-disposable-reminder-indexes.mjs",
      label: "disposable",
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
