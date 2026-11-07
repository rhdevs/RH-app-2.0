/**
 * Creates the INDEXES the proposal collections need: the ones the schema
 * declares in prisma/schema.prisma for `Proposal`, `ProposalStatusHistory`,
 * `ProposalComment` and `ProposalCommentRead`. All are plain (non-expiring);
 * the one unique index is `proposal_comment_read_unique`, one read marker per
 * person per proposal.
 *
 * DO NOT RUN `prisma db push` AGAINST THE CLUSTER INSTEAD OF THIS SCRIPT: a
 * push silently drops `User.email_unique_ci`. See create-transcript-indexes.mjs
 * for the history.
 *
 *   npx prisma generate                                           # types only
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *   node scripts/remediation/create-proposal-indexes.mjs            # DRY RUN
 *   node scripts/remediation/create-proposal-indexes.mjs --commit   # apply
 *   node scripts/remediation/index-census.mjs > census-after.txt
 *   diff census-before.txt census-after.txt
 *
 * ONLY THEN set `proposals.enabled` to "on". The census after must show every
 * index named below.
 *
 * Same engine as the transcript script (`apply`): dry run by default, never
 * drops or modifies an index, refuses on any conflict or existing duplicate,
 * then verifies by reading the indexes back. Touches ONLY the collections in
 * TARGETS. A Vitest test (src/server/api/services/__tests__/
 * proposalIndexes.test.ts) fails if TARGETS and the schema differ.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { isCommit } from "./lib/rbac.mjs";
import { apply } from "./create-transcript-indexes.mjs";

export const TARGETS = {
  Proposal: [
    {
      name: "proposal_cca_status",
      key: { ccaID: 1, status: 1 },
      unique: false,
    },
    {
      name: "proposal_creator",
      key: { createdBy: 1 },
      unique: false,
    },
  ],
  ProposalStatusHistory: [
    {
      name: "proposal_history_proposal_created",
      key: { proposalID: 1, createdAt: 1 },
      unique: false,
    },
  ],
  ProposalComment: [
    {
      name: "proposal_comment_proposal_created",
      key: { proposalID: 1, createdAt: 1 },
      unique: false,
    },
  ],
  ProposalCommentRead: [
    {
      name: "proposal_comment_read_unique",
      key: { proposalID: 1, userID: 1 },
      unique: true,
    },
    {
      name: "proposal_comment_read_user",
      key: { userID: 1 },
      unique: false,
    },
  ],
};

async function main() {
  const db = new PrismaClient();
  try {
    await apply(db, isCommit(), TARGETS, {
      script: "create-proposal-indexes.mjs",
      label: "proposal",
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
