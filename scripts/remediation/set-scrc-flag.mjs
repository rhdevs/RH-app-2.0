/**
 * Turns the Hall Office (SCRC) kill switch on or off (services/scrcFlag.ts).
 *
 *   key:  scrc.enabled   value: "on" | "off"   default (no row): OFF
 *
 * The whole /scrc surface is INERT until this row is "on": listJcrcRoster,
 * resolveJcrcCandidate, setJcrcRole, cca.listAllForOversight,
 * event.listForOversight / getForOversight, and the read-only branch of
 * assertMayViewCcaRoster all refuse with SCRC_DISABLED. It fails CLOSED exactly
 * like isCcaManagementEnabled and isEventsEnabled: a new surface behaves as it
 * did yesterday (i.e. absent) unless someone deliberately enables it.
 *
 *   node scripts/remediation/set-scrc-flag.mjs             # show current
 *   node scripts/remediation/set-scrc-flag.mjs on          # dry run
 *   node scripts/remediation/set-scrc-flag.mjs on --commit # apply
 *   node scripts/remediation/set-scrc-flag.mjs off --commit
 *
 * THIS SCRIPT EXISTS SO THE ROLLOUT IS NOT A HAND EDIT. There is no admin UI for
 * arbitrary SystemFlag rows, so without it step 12 of the rollout is somebody
 * typing into Atlas — unaudited, unverified, and easy to typo into a value that
 * is not exactly "on" (which fails closed and looks like a code bug).
 *
 * WHAT IT DOES *NOT* GATE, so nobody flips it expecting more than it does:
 *   - it does not grant anyone the role (that is /admin/users -> Manage roles),
 *   - it does not open the SCRC Room (that is /admin/facilities on facility 17),
 *   - it does not gate BOOKING at all. Room access is governed purely by the
 *     FacilityAccess row, so turning this off does NOT lock the hall office out
 *     of a room they were already allowed to book. That separation is deliberate.
 *
 * Run `node scripts/remediation/preflight-scrc-validators.mjs` FIRST.
 *
 * NO `prisma db push` IS REQUIRED for the scrc feature — it adds no model and no
 * field, only a SystemFlag ROW, and `db push` silently drops non-schema indexes
 * in this cluster. Do not run it "to be safe".
 */
import { PrismaClient } from "@prisma/client";
import { inspectWriteReply, isCommit, abort, nowExt } from "./lib/rbac.mjs";

const db = new PrismaClient();

const KEY = "scrc.enabled";
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
  console.log(`\n=== set-scrc-flag.mjs ===`);
  const before = await current();
  console.log(
    `current: ${before ? JSON.stringify(before.value) : '(no row — surface is OFF)'}`,
  );

  if (!MODE) {
    console.log(
      `\nusage: node scripts/remediation/set-scrc-flag.mjs <${MODES.join("|")}> [--commit]`,
    );
    return;
  }
  if (!MODES.includes(MODE)) {
    return abort(`mode must be one of ${MODES.join(" | ")} — got ${JSON.stringify(MODE)}`);
  }

  // Reported, never enforced: switching the surface on before anybody holds the
  // role is harmless (nothing changes for anyone), but it is almost always a
  // sign the rollout steps were done out of order, and the operator should see
  // that before they walk away thinking the feature is live.
  if (MODE === "on") {
    const holders = await db.userRole.count({
      where: { OR: [{ roles: { has: "scrc" } }, { role: "scrc" }] },
    });
    console.log(`accounts currently holding "scrc": ${holders}`);
    if (holders === 0) {
      console.log(
        `  note: nobody holds the role yet, so turning this on changes nothing ` +
          `visible. Grant it via /admin/users -> Manage roles (which audits).`,
      );
    }
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
            updatedBy: "script:set-scrc-flag",
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
  // The per-lambda cache in scrcFlag.ts is 15s, so a deploy already running will
  // pick this up within that window without a redeploy. That is the whole point
  // of the switch being a row rather than an env var.
  console.log(`effective on all running instances within ~15s (scrcFlag.ts cache TTL).`);
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
