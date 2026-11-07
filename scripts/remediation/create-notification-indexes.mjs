/**
 * Creates the INDEXES the in-app inbox needs on `Notification`: the two the
 * schema declares in prisma/schema.prisma, plus the expiry (TTL) index that
 * Prisma cannot express and that is therefore NOT in the schema.
 *
 * DO NOT RUN `prisma db push` AGAINST THE CLUSTER INSTEAD OF THIS SCRIPT: a
 * push silently drops `User.email_unique_ci`, and it would also drop the TTL
 * index below, which it cannot see. See create-transcript-indexes.mjs and
 * create-event-phase2-indexes.mjs for the history.
 *
 *   npx prisma generate                                              # types only
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *   node scripts/remediation/create-notification-indexes.mjs            # DRY RUN
 *   node scripts/remediation/create-notification-indexes.mjs --commit   # apply
 *   node scripts/remediation/index-census.mjs > census-after.txt
 *   diff census-before.txt census-after.txt
 *
 * ONLY THEN set `notifications.enabled` to "on". Until `notification_expiry`
 * exists nothing ever deletes a row, and the inbox would grow without bound.
 *
 * `notification_expiry` deletes a row once its own `expiresAt` has passed
 * (`expireAfterSeconds: 0`). `notify` sets `expiresAt` to about 180 days after
 * creation (Q21), so the retention period is code, not index metadata, and can
 * change without rebuilding the index. MongoDB's reaper runs about once a
 * minute, so a row may outlive its date briefly. The census shows the option.
 *
 * Same engine as the transcript script (`apply`, extended with the optional
 * `expireAfterSeconds` entry key): dry run by default, never drops or modifies
 * an index, refuses on any conflict (including an index of that name with a
 * different TTL) or existing duplicate, then verifies by reading the indexes
 * back. Touches ONLY the collection in TARGETS. A Vitest test (src/server/api/
 * services/__tests__/notificationIndexes.test.ts) fails if TARGETS and the
 * schema differ.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { isCommit } from "./lib/rbac.mjs";
import { apply } from "./create-transcript-indexes.mjs";

export const TARGETS = {
  Notification: [
    {
      name: "notification_user_created",
      key: { userID: 1, createdAt: 1 },
      unique: false,
    },
    {
      name: "notification_user_read",
      key: { userID: 1, readAt: 1 },
      unique: false,
    },
    {
      name: "notification_expiry",
      key: { expiresAt: 1 },
      unique: false,
      expireAfterSeconds: 0,
    },
  ],
};

async function main() {
  const db = new PrismaClient();
  try {
    await apply(db, isCommit(), TARGETS, {
      script: "create-notification-indexes.mjs",
      label: "notification",
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
