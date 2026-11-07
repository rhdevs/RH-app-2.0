/**
 * Creates the INDEXES the JCRC positions feature declares in
 * prisma/schema.prisma (JcrcPosition, JcrcPositionCca, JcrcPositionHolder,
 * JcrcTerm), with the same names, keys and uniqueness.
 *
 * DO NOT RUN `prisma db push` AGAINST THE CLUSTER INSTEAD OF THIS SCRIPT: a
 * push silently drops `User.email_unique_ci`. See create-transcript-indexes.mjs
 * and create-event-phase2-indexes.mjs for the history.
 *
 *   npx prisma generate                                              # types only
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *   node scripts/remediation/create-jcrc-position-indexes.mjs            # DRY RUN
 *   node scripts/remediation/create-jcrc-position-indexes.mjs --commit   # apply
 *   node scripts/remediation/index-census.mjs > census-after.txt
 *   diff census-before.txt census-after.txt
 *
 * The uniques matter: without `jcrcPosition_name` two positions can share a
 * name (the router's NAME_TAKEN never fires), and without the two pair indexes
 * a CCA or holder can be listed twice on one position, which the handover's
 * upserts rely on never happening.
 *
 * Same engine as the transcript script (`apply`): dry run by default, never
 * drops or modifies an index, refuses on any conflict or existing duplicate,
 * then verifies by reading the indexes back. Touches ONLY the four collections
 * in TARGETS. A Vitest test (src/server/api/services/__tests__/
 * jcrcPositionIndexes.test.ts) fails if TARGETS and the schema differ.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { isCommit } from "./lib/rbac.mjs";
import { apply } from "./create-transcript-indexes.mjs";

export const TARGETS = {
  JcrcPosition: [{ name: "jcrcPosition_name", key: { name: 1 }, unique: true }],
  JcrcPositionCca: [
    {
      name: "jcrcPositionCca_pair",
      key: { positionID: 1, ccaID: 1 },
      unique: true,
    },
    { name: "jcrcPositionCca_ccaID", key: { ccaID: 1 }, unique: false },
  ],
  JcrcPositionHolder: [
    {
      name: "jcrcPositionHolder_pair",
      key: { positionID: 1, userID: 1 },
      unique: true,
    },
    {
      name: "jcrcPositionHolder_userID",
      key: { userID: 1 },
      unique: false,
    },
  ],
  JcrcTerm: [{ name: "jcrcTerm_userID", key: { userID: 1 }, unique: true }],
};

async function main() {
  const db = new PrismaClient();
  try {
    await apply(db, isCommit(), TARGETS, {
      script: "create-jcrc-position-indexes.mjs",
      label: "JCRC position",
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
