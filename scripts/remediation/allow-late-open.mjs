/**
 * Lets JCRC open transcripts ONCE for a PAST academic year they forgot to open
 * before 1 August. The app refuses such a year (YEAR_ENDED) because the August
 * application period has changed the CCA member lists; this script only sets a
 * 7-day allowance on that year's TranscriptPeriod row. JCRC then presses Open
 * transcripts in the app as usual; the dialog warns that TODAY's member lists
 * will be used. The allowance is cleared in the same write that opens the
 * year, so it is single use, and it expires on its own after 7 days.
 *
 *   node scripts/remediation/allow-late-open.mjs 2026-27            # dry run
 *   node scripts/remediation/allow-late-open.mjs 2026-27 --commit    # grant
 *
 * Refuses: a malformed year, a year before AY2026/27, the current year, a
 * future year, and (with a database) a year whose transcripts are already
 * open. DRY RUN by default. Rules: scripts/remediation/lib/lateOpen.mjs.
 */
import { PrismaClient } from "@prisma/client";
import { isCommit, abort } from "./lib/rbac.mjs";
import { describeTarget } from "./lib/dbTarget.mjs";
import {
  allowanceExpiry,
  formatSingaporeTime,
  validateLateOpenYear,
} from "./lib/lateOpen.mjs";

const SETTER = "script";
const COMMIT = isCommit();

async function main(db) {
  console.log(`\n=== allow-late-open.mjs ===`);
  console.log(`target: ${describeTarget(process.env.DATABASE_URL)}`);

  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!arg) {
    console.log(
      `\nusage: node scripts/remediation/allow-late-open.mjs <AY like 2026-27> [--commit]`,
    );
    return;
  }
  const now = new Date();
  const year = validateLateOpenYear(arg, now);
  if (!year.ok) return abort(year.reason);
  const { academicYear } = year;

  const before = await db.transcriptPeriod.findUnique({
    where: { academicYear },
    select: { status: true, lateOpenAllowedUntil: true },
  });
  if (before?.status === "published") {
    return abort(
      `${academicYear} is already open; nothing to allow. The allowance is for a year that was never opened.`,
    );
  }
  const until = allowanceExpiry(now);
  console.log(
    `\n  ${COMMIT ? "+" : "~"} ${academicYear}: ${before ? `status ${before.status ?? "collecting"}` : "no period row yet (would be created as collecting)"}`,
  );
  console.log(
    `    lateOpenAllowedUntil -> ${until.toISOString()} (${formatSingaporeTime(until)})`,
  );
  console.log(`    lateOpenAllowedBy    -> ${SETTER}`);
  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    return;
  }

  await db.transcriptPeriod.upsert({
    where: { academicYear },
    create: {
      academicYear,
      status: "collecting",
      lateOpenAllowedUntil: until,
      lateOpenAllowedBy: SETTER,
    },
    update: { lateOpenAllowedUntil: until, lateOpenAllowedBy: SETTER },
  });

  const after = await db.transcriptPeriod.findUnique({
    where: { academicYear },
    select: { lateOpenAllowedUntil: true, lateOpenAllowedBy: true },
  });
  console.log(`\n=== VERIFY ===`);
  if (
    !after?.lateOpenAllowedUntil ||
    after.lateOpenAllowedUntil.getTime() !== until.getTime() ||
    after.lateOpenAllowedBy !== SETTER
  ) {
    return abort(`read-back mismatch: the allowance was NOT confirmed.`);
  }
  console.log(
    `${academicYear}: JCRC can open it until ${formatSingaporeTime(after.lateOpenAllowedUntil)} (single use).`,
  );
  console.log(
    `Tell JCRC to press Open transcripts for ${academicYear}; today's member lists will be used.`,
  );
}

const db = new PrismaClient();
main(db)
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
