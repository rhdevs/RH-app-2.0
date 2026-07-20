/**
 * Sets a CCA feature kill switch. These are NEW-WRITE-SURFACE switches, so
 * unlike the rbac.* enforcement switches they are on|off and DEFAULT OFF (an
 * absent row = off = the surface is inert). See ccaScope.isCcaManagementEnabled
 * and ccaApplications.isApplicationsEnabled — both read `value === "on"`.
 *
 *   management    cca.management.enabled     /admin/manage-ccas (create/rename
 *                                            CCAs, add/remove members)
 *   applications  cca.applications.enabled   the resident applications +
 *                                            interview workflow (/ccas)
 *
 *   node scripts/remediation/set-cca-flag.mjs                              # show both
 *   node scripts/remediation/set-cca-flag.mjs management on                # dry run
 *   node scripts/remediation/set-cca-flag.mjs management on --commit       # apply
 *   node scripts/remediation/set-cca-flag.mjs applications on --commit
 *
 * A SystemFlag ROW, not an env var, for the same reason as set-enforcement.mjs:
 * Vercel snapshots env vars per deployment, so only a DB row is a no-redeploy
 * switch. Writes via $runCommandRaw and INSPECTS THE REPLY (I-8f) rather than
 * trusting a throw, then reads the row back to verify.
 */
import { PrismaClient } from "@prisma/client";
import { inspectWriteReply, isCommit, abort, nowExt } from "./lib/rbac.mjs";

const db = new PrismaClient();

const SWITCHES = {
  management: { key: "cca.management.enabled" },
  applications: { key: "cca.applications.enabled" },
};
const MODES = ["on", "off"];

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const NAME = positional[0];
const MODE = positional[1];
const COMMIT = isCommit();

async function readFlag(key) {
  const r = await db.$runCommandRaw({
    find: "SystemFlag",
    filter: { key },
    limit: 1,
  });
  return r?.cursor?.firstBatch?.[0] ?? null;
}

async function showAll() {
  console.log(`\n=== set-cca-flag.mjs — current state ===`);
  for (const [name, { key }] of Object.entries(SWITCHES)) {
    const row = await readFlag(key);
    const val = row ? JSON.stringify(row.value) : `(no row — default "off")`;
    console.log(`  ${name.padEnd(13)} ${key.padEnd(26)} ${val}`);
  }
  console.log(
    `\nusage: node scripts/remediation/set-cca-flag.mjs <${Object.keys(
      SWITCHES,
    ).join("|")}> <on|off> [--commit]`,
  );
}

async function main() {
  if (!NAME) return showAll();

  const SWITCH = SWITCHES[NAME];
  if (!SWITCH) {
    return abort(
      `unknown switch ${JSON.stringify(NAME)} — one of ${Object.keys(
        SWITCHES,
      ).join(" | ")}`,
    );
  }
  const KEY = SWITCH.key;

  const before = await readFlag(KEY);
  console.log(`\n=== set-cca-flag.mjs (${NAME}) ===`);
  console.log(
    `current: ${before ? JSON.stringify(before.value) : `(no row — default "off")`}`,
  );

  if (!MODE) {
    console.log(
      `\nusage: node scripts/remediation/set-cca-flag.mjs ${NAME} <${MODES.join(
        "|",
      )}> [--commit]`,
    );
    return;
  }
  if (!MODES.includes(MODE)) {
    return abort(`mode must be one of ${MODES.join(" | ")} — got ${JSON.stringify(MODE)}`);
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
            updatedBy: `script:set-cca-flag:${NAME}`,
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

  const after = await readFlag(KEY);
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
