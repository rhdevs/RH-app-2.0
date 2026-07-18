/**
 * Sets an RBAC kill switch (I-11). There are THREE, all defaulting to "off":
 *
 *   booking   rbac.booking.enforcement   default-deny room booking
 *   matric    rbac.matric.enforcement    the matric onboarding gate (off|enforce)
 *   auth      rbac.auth.enforcement      the D-7 @u.nus.edu sign-in restriction
 *
 *   node scripts/remediation/set-enforcement.mjs                          # show all three
 *   node scripts/remediation/set-enforcement.mjs booking off              # dry run
 *   node scripts/remediation/set-enforcement.mjs booking off --commit     # apply
 *   node scripts/remediation/set-enforcement.mjs auth permissive --commit
 *
 * The switch name may be omitted, in which case it defaults to `booking` — the
 * historical behaviour of this script.
 *
 * SET IT TO "off" BEFORE ANY PHASE 2 CODE DEPLOYS, so the new default-deny code
 * lands behaviourally INERT and the rollout is a data-only flip afterwards.
 *
 * "off" means LEGACY SEMANTICS, not blanket-allow (I-11). It is the default at
 * every level: this flag, and the RBAC_BOOKING_ENFORCEMENT env floor in
 * src/env.js, so a wiped SystemFlag collection cannot silently start enforcing.
 *
 * This is a SystemFlag row rather than an env var because Vercel snapshots env
 * vars per deployment — an env var alone cannot be a no-redeploy kill switch.
 *
 * ORDER OF THE ROLLOUT (02-backend-authz.md owns the semantics,
 * 05-verification.md owns the shadow-soak protocol):
 *     off  ->  permissive  ->  enforce
 * Do not skip "permissive": it is what produces the shadow-denial log that
 * rbac-doctor's "shadow denials, last 24h" line reads, and that line is the
 * go/no-go for "enforce".
 */
import { PrismaClient } from "@prisma/client";
import { inspectWriteReply, isCommit, abort, nowExt } from "./lib/rbac.mjs";

const db = new PrismaClient();

/**
 * The matric gate is off|enforce only: it has no shadow mode, because a
 * "permissive" matric gate is indistinguishable from "off" (nothing to log —
 * the gate either denies or it does not).
 */
const SWITCHES = {
  booking: { key: "rbac.booking.enforcement", modes: ["off", "permissive", "enforce"], soak: true },
  matric: { key: "rbac.matric.enforcement", modes: ["off", "enforce"], soak: false },
  auth: { key: "rbac.auth.enforcement", modes: ["off", "permissive", "enforce"], soak: true },
};

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// `<switch> <mode>` or, for backwards compatibility, a bare `<mode>` meaning booking.
const NAME = positional.length > 1 ? positional[0] : "booking";
const MODE = positional.length > 1 ? positional[1] : positional[0];
const COMMIT = isCommit();

const SWITCH = SWITCHES[NAME];
const KEY = SWITCH?.key;
const MODES = SWITCH?.modes ?? [];

async function readFlag(key) {
  const r = await db.$runCommandRaw({ find: "SystemFlag", filter: { key }, limit: 1 });
  return r?.cursor?.firstBatch?.[0] ?? null;
}

async function current() {
  return readFlag(KEY);
}

async function main() {
  console.log(`\n=== set-enforcement.mjs ===`);
  const before = await current();
  console.log(`current: ${before ? JSON.stringify(before.value) : "(no row — code falls back to the env floor, default \"off\")"}`);

  if (!MODE) {
    console.log(`\nusage: node scripts/remediation/set-enforcement.mjs <${MODES.join("|")}> [--commit]`);
    return;
  }
  if (!MODES.includes(MODE)) {
    return abort(`mode must be one of ${MODES.join(" | ")} — got ${JSON.stringify(MODE)}`);
  }

  // Refuse to skip the soak stage. "off" -> "enforce" in one step deploys
  // default-deny to ~515 users with no shadow-denial evidence that the baseline
  // backfill actually covered them.
  if (SWITCH.soak && MODE === "enforce" && (before?.value ?? "off") === "off") {
    return abort(`refusing to jump "off" -> "enforce". Go through "permissive" and soak it: ` +
      `the shadow-denial log it produces is the ONLY evidence that flipping to enforce will ` +
      `not lock out users the resident backfill missed. Set "permissive" first.`);
  }

  console.log(`\n  ${COMMIT ? "+" : "~"} ${KEY}: ${JSON.stringify(before?.value ?? null)} -> ${JSON.stringify(MODE)}`);
  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --commit to apply.`);
    return;
  }

  const reply = await db.$runCommandRaw({
    update: "SystemFlag",
    updates: [{
      q: { key: KEY },
      // `key` is $set here, so it must NOT also appear in a $setOnInsert —
      // the same path in both operators is a MongoDB parse error.
      u: { $set: { key: KEY, value: MODE, updatedAt: nowExt(), updatedBy: `script:set-enforcement:${NAME}` } },
      upsert: true,
    }],
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
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
