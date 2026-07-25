/**
 * Turns the Events feature kill switch on or off (services/events.ts).
 *
 *   key:  events.enabled   value: "on" | "off"   default (no row): OFF
 *
 * The whole Events surface — the resident timeline, head authoring, JCRC review,
 * signup, the upload route — is INERT until this row is "on". It fails CLOSED
 * exactly like isCcaManagementEnabled: a new write surface behaves as it did
 * yesterday (i.e. absent) unless someone deliberately enables it.
 *
 *   node scripts/remediation/set-events-flag.mjs             # show current
 *   node scripts/remediation/set-events-flag.mjs on          # dry run
 *   node scripts/remediation/set-events-flag.mjs on --commit # apply
 *   node scripts/remediation/set-events-flag.mjs off --commit
 *
 * Run `npx prisma db push` FIRST so the Event / EventSignup / EventLock
 * collections and their unique indexes exist before the feature is switched on.
 */
import { PrismaClient } from "@prisma/client";
import { inspectWriteReply, isCommit, abort, nowExt } from "./lib/rbac.mjs";

const db = new PrismaClient();

const KEY = "events.enabled";
const MODES = ["on", "off"];

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const MODE = positional[0];
const COMMIT = isCommit();

async function current() {
  const r = await db.$runCommandRaw({
    find: "SystemFlag",
    filter: { key: KEY },
    limit: 1,
  });
  return r?.cursor?.firstBatch?.[0] ?? null;
}

async function main() {
  console.log(`\n=== set-events-flag.mjs ===`);
  const before = await current();
  console.log(
    `current: ${before ? JSON.stringify(before.value) : '(no row — feature is OFF)'}`,
  );

  if (!MODE) {
    console.log(
      `\nusage: node scripts/remediation/set-events-flag.mjs <${MODES.join("|")}> [--commit]`,
    );
    return;
  }
  if (!MODES.includes(MODE)) {
    return abort(`mode must be one of ${MODES.join(" | ")} — got ${JSON.stringify(MODE)}`);
  }

  console.log(
    `\n  ${COMMIT ? "+" : "~"} ${KEY}: ${JSON.stringify(before?.value ?? null)} -> ${JSON.stringify(MODE)}`,
  );
  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    return;
  }

  const reply = await db.$runCommandRaw({
    update: "SystemFlag",
    updates: [
      {
        q: { key: KEY },
        u: {
          $set: {
            key: KEY,
            value: MODE,
            updatedAt: nowExt(),
            updatedBy: "script:set-events-flag",
          },
        },
        upsert: true,
      },
    ],
  });
  const r = inspectWriteReply(reply, KEY);
  if (r.writeErrors.length) {
    console.error(`  ! WRITE FAILED: ${JSON.stringify(r.writeErrors)}`);
    return abort(`the flag was NOT changed.`);
  }

  const after = await current();
  console.log(`\n=== VERIFY ===`);
  console.log(`${KEY} = ${JSON.stringify(after?.value ?? null)}`);
  if (after?.value !== MODE) {
    return abort(`read-back mismatch: expected ${MODE}, got ${JSON.stringify(after?.value ?? null)}`);
  }
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
