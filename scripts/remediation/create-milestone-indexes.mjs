/**
 * Creates the INDEXES the milestone collections need. PR 15 (private evidence
 * uploads) has ONE collection, `MilestoneEvidence`; PR 16 (milestones) adds its
 * two collections to the TARGETS map below, so one script and one drift test
 * cover the whole feature. Every index here is one that
 * prisma/schema.prisma declares: Prisma's own `db push` is NOT how they are
 * built (see below), this script is.
 *
 * `milestone_evidence_pathname` is UNIQUE: one stored row per blob, so a
 * pathname cannot be recorded twice (a replayed record call, or a second CCA
 * claiming the same file). The doctor checks it.
 *
 * DO NOT RUN `prisma db push` AGAINST THE CLUSTER INSTEAD OF THIS SCRIPT: a
 * push silently drops `User.email_unique_ci`. See create-transcript-indexes.mjs
 * for the history.
 *
 *   npx prisma generate                                              # types only
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *   node scripts/remediation/create-milestone-indexes.mjs            # DRY RUN
 *   node scripts/remediation/create-milestone-indexes.mjs --commit   # apply
 *   node scripts/remediation/index-census.mjs > census-after.txt
 *   diff census-before.txt census-after.txt
 *
 * ONLY THEN set `milestones.enabled` to "on". The census after must show every
 * index named below; the doctor goes RED if the flag is on and the evidence
 * index is missing.
 *
 * Same engine as the transcript script (`apply`): dry run by default, never
 * drops or modifies an index, refuses on any conflict or existing duplicate,
 * then verifies by reading the indexes back. Touches ONLY the collections in
 * TARGETS. A Vitest test (src/server/api/services/__tests__/
 * milestoneIndexes.test.ts) fails if TARGETS and the schema differ.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { isCommit } from "./lib/rbac.mjs";
import { apply } from "./create-transcript-indexes.mjs";

export const TARGETS = {
  MilestoneEvidence: [
    {
      name: "milestone_evidence_pathname",
      key: { pathname: 1 },
      unique: true,
    },
    {
      name: "milestone_evidence_cca_submission",
      key: { ccaID: 1, submissionID: 1, createdAt: 1 },
      unique: false,
    },
  ],
};

async function main() {
  const db = new PrismaClient();
  try {
    await apply(db, isCommit(), TARGETS, {
      script: "create-milestone-indexes.mjs",
      label: "milestone",
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
