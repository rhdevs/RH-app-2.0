/**
 * Creates the INDEXES the calendar feed needs, on `CalendarFeedToken` (F20):
 * the two unique indexes the schema declares in prisma/schema.prisma, one
 * token per person (`calendar_feed_user`) and one owner per token hash
 * (`calendar_feed_hash`). The second is what makes a feed lookup one indexed
 * read, and what stops two people ever sharing a link. Both are plain unique
 * indexes; nothing here expires.
 *
 * DO NOT RUN `prisma db push` AGAINST THE CLUSTER INSTEAD OF THIS SCRIPT: a
 * push silently drops `User.email_unique_ci`. See create-transcript-indexes.mjs
 * for the history.
 *
 *   npx prisma generate                                              # types only
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *   node scripts/remediation/create-calendar-feed-indexes.mjs            # DRY RUN
 *   node scripts/remediation/create-calendar-feed-indexes.mjs --commit   # apply
 *   node scripts/remediation/index-census.mjs > census-after.txt
 *   diff census-before.txt census-after.txt
 *
 * ONLY THEN set `calendar.feed.enabled` to "on". The census after must show
 * both indexes named below. Without the unique index on the hash, two rows
 * with the same hash could exist and a feed would open the wrong calendar.
 *
 * Same engine as the transcript script (`apply`): dry run by default, never
 * drops or modifies an index, refuses on any conflict or existing duplicate,
 * then verifies by reading the indexes back. Touches ONLY the collections in
 * TARGETS. A Vitest test (src/server/api/services/__tests__/
 * calendarFeedIndexes.test.ts) fails if TARGETS and the schema differ.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { isCommit } from "./lib/rbac.mjs";
import { apply } from "./create-transcript-indexes.mjs";

export const TARGETS = {
  CalendarFeedToken: [
    {
      name: "calendar_feed_user",
      key: { userID: 1 },
      unique: true,
    },
    {
      name: "calendar_feed_hash",
      key: { tokenHash: 1 },
      unique: true,
    },
  ],
};

async function main() {
  const db = new PrismaClient();
  try {
    await apply(db, isCommit(), TARGETS, {
      script: "create-calendar-feed-indexes.mjs",
      label: "calendar feed",
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
