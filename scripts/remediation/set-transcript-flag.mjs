/**
 * Sets the Transcript feature's kill switch, `transcript.enabled`. The same
 * kind of switch as set-cca-flag.mjs: a NEW-SURFACE switch, on|off, DEFAULT
 * OFF (an absent row = off = every transcript procedure refuses with
 * TRANSCRIPT_DISABLED). See src/server/api/services/transcript/flag.ts, which
 * reads `value === "on"` (cached for 15 seconds per server instance).
 *
 *   node scripts/remediation/set-transcript-flag.mjs                 # show
 *   node scripts/remediation/set-transcript-flag.mjs on              # dry run
 *   node scripts/remediation/set-transcript-flag.mjs on --commit     # apply
 *   node scripts/remediation/set-transcript-flag.mjs off --commit    # turn off
 *
 * ROLLOUT ORDER: turn it on only AFTER create-transcript-indexes.mjs --commit
 * has built the unique indexes (and the census diff shows only the transcript
 * collections). Until then the duplicate guards the services rely on enforce
 * nothing.
 *
 * A SystemFlag ROW, not an env var: Vercel snapshots env vars per deployment,
 * so only a DB row is a no-redeploy switch. Writes via $runCommandRaw and
 * INSPECTS THE REPLY rather than trusting a throw, then reads the row back.
 */
import { PrismaClient } from "@prisma/client";
import { inspectWriteReply, isCommit, abort, nowExt } from "./lib/rbac.mjs";
import { describeTarget } from "./lib/dbTarget.mjs";
import { checkUniqueIndexes } from "./lib/transcriptIndexes.mjs";
import { TARGETS } from "./create-transcript-indexes.mjs";

const db = new PrismaClient();

const KEY = "transcript.enabled";
const MODES = ["on", "off"];

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const MODE = positional[0];
const COMMIT = isCommit();

async function readFlag() {
  const r = await db.$runCommandRaw({
    find: "SystemFlag",
    filter: { key: KEY },
    limit: 1,
  });
  return r?.cursor?.firstBatch?.[0] ?? null;
}

async function main() {
  console.log(`\n=== set-transcript-flag.mjs ===`);
  // Before anything is read or written, for the dry run and --commit alike.
  console.log(`target: ${describeTarget(process.env.DATABASE_URL)}`);
  const before = await readFlag();
  console.log(
    `current: ${KEY} = ${before ? JSON.stringify(before.value) : `(no row — default "off")`}`,
  );

  if (!MODE) {
    console.log(
      `\nusage: node scripts/remediation/set-transcript-flag.mjs <${MODES.join(
        "|",
      )}> [--commit]`,
    );
    return;
  }
  if (!MODES.includes(MODE)) {
    return abort(
      `mode must be one of ${MODES.join(" | ")} — got ${JSON.stringify(MODE)}`,
    );
  }

  if (MODE === "on") {
    const indexes = await checkUniqueIndexes(db, TARGETS);
    if (!indexes.ok) {
      for (const p of indexes.problems) console.error(`  RED  ${p}`);
      return abort(
        `the unique indexes are not all in place, so the flag was NOT changed. Run create-transcript-indexes.mjs --commit first.`,
      );
    }
  }

  console.log(
    `\n  ${COMMIT ? "+" : "~"} ${KEY}: ${JSON.stringify(
      before?.value ?? null,
    )} -> ${JSON.stringify(MODE)}`,
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
            updatedBy: "script:set-transcript-flag",
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

  const after = await readFlag();
  console.log(`\n=== VERIFY ===`);
  console.log(`${KEY} = ${JSON.stringify(after?.value ?? null)}`);
  if (after?.value !== MODE) {
    return abort(
      `read-back mismatch: expected ${MODE}, got ${JSON.stringify(after?.value ?? null)}`,
    );
  }
  console.log(
    `Server instances pick this up within 15 seconds (the per-instance cache).`,
  );
}

// Always runs: this is the production kill switch, so it must never exit 0
// having done nothing (a check on argv[1] fails on a symlink, a junction or a
// drive-letter case difference). describeTarget lives in lib/dbTarget.mjs.
main()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
