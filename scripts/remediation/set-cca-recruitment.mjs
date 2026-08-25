/**
 * Sets the CCA recruitment freeze — the ONE hall-wide switch behind the three
 * points at which the applicant pool or the roster GROWS:
 *   ccaApplications.submitApplication      a resident applying
 *   ccaApplications.bookSlot               a resident claiming an interview seat
 *   ccaApplicationsHead.decide (accepted)  a head accepting
 *
 * Everything that leaves the pool the same size or SMALLER keeps working
 * regardless of this flag: reject, withdraw, either side's cancelSlot, the
 * head's slot creation (nobody can claim the slots while closed) and
 * markInterviewed, plus every read.
 *
 * bookSlot joined the list on 2026-08-25 at the user's direction, reversing the
 * plan's D11. NOTE FOR ANYONE READING AN OLD PLAN: D11 argued the opposite and
 * is now annotated as reversed.
 *
 *   key:   cca.recruitment        value: "open" | "closed"
 *   default (no row):             OPEN
 *
 * THAT DEFAULT IS THE OPPOSITE of every other switch in this directory, and
 * deliberately so (plan D2/D3): the three existing `*.enabled` flags
 * (cca.management.enabled, cca.applications.enabled, scrc.enabled) all mean
 * "absent row = OFF = the surface is inert" — they gate NEW write surfaces that
 * must not go live before someone deliberately arms them. `cca.recruitment`
 * gates an EXISTING surface that already works in production today; if this
 * flag defaulted to closed, shipping this feature would freeze the hall on
 * deploy with nobody having touched a switch. So: no row means applications
 * behave exactly as they did yesterday — OPEN.
 *
 * A row that DOES exist with any value other than exactly "open" or "closed" is
 * treated as CLOSED, not open (plan D5). Absence and garbage are different
 * facts: absence means "never configured" (open); a row that exists proves
 * somebody deliberately wrote it, and if we cannot read what they meant, the
 * safe reading of a *freeze* control is frozen. A typo therefore fails loudly
 * (recruitment stays visibly shut, someone reports it) rather than silently
 * (the freeze quietly never applies). verify-recruitment-gate.mjs's check [2]
 * exists to catch exactly this.
 *
 * TWO DELIBERATE DIFFERENCES FROM set-cca-flag.mjs, the sibling script this one
 * is otherwise modelled on line-for-line (its dry-run-by-default, its
 * $runCommandRaw write, its INSPECT-THE-REPLY discipline per I-8f rather than
 * trusting a throw — Mongo $jsonSchema validators can reject a write with
 * `ok: 1` and a `writeErrors` array and NO throw at all — and its read-back
 * verify are all reproduced here unchanged):
 *
 *   1. MODES here are "open" / "closed", never "on" / "off". Naming this key
 *      `cca.recruitment.enabled` or accepting on/off would put it in the
 *      default-off family it deliberately does not belong to, and would invite
 *      the next person to add it to set-cca-flag.mjs's SWITCHES map by reflex,
 *      inheriting default-off semantics it must not have. It is NOT added to
 *      that map for the same reason.
 *
 *   2. The "no row" line below prints `(no row — default "open")`. This is the
 *      INVERSE of set-cca-flag.mjs's equivalent line (`(no row — default
 *      "off")`, around its line 52). Getting this backwards in operator-facing
 *      output is precisely how someone reads a wide-open recruitment period as
 *      a frozen one and starts telling residents applications are down — or the
 *      reverse, reads a frozen hall as open and tells a head to keep accepting.
 *
 *   node scripts/remediation/set-cca-recruitment.mjs                    # show current
 *   node scripts/remediation/set-cca-recruitment.mjs closed             # dry run
 *   node scripts/remediation/set-cca-recruitment.mjs closed --commit    # apply
 *   node scripts/remediation/set-cca-recruitment.mjs open --commit
 *
 * A SystemFlag ROW, not an env var, for the same reason as set-scrc-flag.mjs /
 * set-enforcement.mjs: Vercel snapshots env vars per deployment, so only a DB
 * row is a no-redeploy switch. The document written is EXACTLY
 * `{ key, value, updatedAt, updatedBy }` — no other field. SystemFlag carries
 * no $jsonSchema validator (prisma/schema.prisma:434, "New collection, no
 * validator"), so a plain Prisma `systemFlag.upsert` would also be safe here,
 * but this script stays on $runCommandRaw + inspectWriteReply to match every
 * sibling break-glass script's write discipline rather than special-case one
 * validator-free collection.
 *
 * `updatedBy` is written as the literal `script:set-cca-recruitment` — no
 * per-mode suffix the way set-cca-flag.mjs appends its switch name, because
 * there is only one switch here, nothing to disambiguate. The admin panel's
 * status read special-cases any `script:`-prefixed `updatedBy` and renders it
 * verbatim instead of trying to resolve it to a person.
 *
 * THIS SCRIPT DOES NOT SPEED UP PROPAGATION. Every lambda that reads this flag
 * caches it for FLAG_TTL_MS (15s, shared reasoning across five services — plan
 * R2; do not shorten it for this flag alone). This script writes the row and
 * reads it back to confirm the WRITE, but it cannot reach into another running
 * instance's in-memory cache — someone mid-submit in that window may still get
 * through. That is accepted, not a defect in this script.
 *
 * NO `prisma db push` IS REQUIRED, and none should ever be run for this
 * feature — it adds no model and no field, only a SystemFlag row, and `db
 * push` silently drops non-schema indexes in this cluster.
 */
import { PrismaClient } from "@prisma/client";
import { inspectWriteReply, isCommit, abort, nowExt } from "./lib/rbac.mjs";

const db = new PrismaClient();

const KEY = "cca.recruitment";
const MODES = ["open", "closed"];

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

/**
 * Mirrors isRecruitmentOpen()'s own reading of the row (D3/D5), so this
 * script's summary line can never disagree with what the server actually does.
 * Absence -> open. Exactly "open" -> open. Exactly "closed" -> closed. Anything
 * else -> closed, flagged as unrecognised.
 */
function describe(row) {
  if (!row) return { open: true, label: `(no row — default "open")` };
  if (row.value === "open") return { open: true, label: `"open"` };
  if (row.value === "closed") return { open: false, label: `"closed"` };
  return {
    open: false,
    label: `${JSON.stringify(row.value)} (UNRECOGNISED VALUE — treated as "closed", same as an unreadable row)`,
  };
}

async function main() {
  console.log(`\n=== set-cca-recruitment.mjs ===`);
  const before = await current();
  const beforeState = describe(before);
  console.log(
    `current: ${beforeState.label}  ->  recruitment is ${beforeState.open ? "OPEN" : "CLOSED"}`,
  );

  if (!MODE) {
    console.log(
      `\nusage: node scripts/remediation/set-cca-recruitment.mjs <${MODES.join(
        "|",
      )}> [--commit]`,
    );
    return;
  }
  if (!MODES.includes(MODE)) {
    return abort(
      `mode must be one of ${MODES.join(" | ")} — got ${JSON.stringify(MODE)}. ` +
        `("on"/"off" belong to the OTHER flags' vocabulary, not this one's — plan D2.)`,
    );
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
            updatedBy: "script:set-cca-recruitment",
          },
        },
        upsert: true,
      },
    ],
  });
  const r = inspectWriteReply(reply, KEY);
  // writeConcernError COUNTS AS FAILURE, and is checked separately from
  // writeErrors because it means something different: the write was ACCEPTED by
  // the primary but not acknowledged by enough replicas, so it may yet be
  // rolled back on a failover. For a hall-wide freeze that is the difference
  // between "recruitment is stopped" and "recruitment is stopped until the next
  // election". set-cca-flag.mjs, the script this one is modelled on, checks only
  // writeErrors; backfill-slot-capacity.mjs gets it right and says so outright,
  // and this follows the latter. The read-back below is a second net, but it can
  // race the same failover, so neither check replaces the other.
  //
  // `.length`, NOT truthiness: inspectWriteReply normalises writeConcernError
  // into an ARRAY (lib/rbac.mjs), and an empty array is truthy in JS — a bare
  // `|| r.writeConcernError` would abort every successful write.
  if (r.writeErrors.length || r.writeConcernError.length) {
    console.error(
      `  ! WRITE FAILED: ${JSON.stringify({
        writeErrors: r.writeErrors,
        writeConcernError: r.writeConcernError,
      })}`,
    );
    return abort(`the flag was NOT changed.`);
  }

  const after = await current();
  console.log(`\n=== VERIFY ===`);
  console.log(`${KEY} = ${JSON.stringify(after?.value ?? null)}`);
  if (after?.value !== MODE) {
    return abort(
      `read-back mismatch: expected ${MODE}, got ${JSON.stringify(after?.value ?? null)}`,
    );
  }
  console.log(
    `effective on all running instances within ~15s (shared FLAG_TTL_MS cache — plan R2).`,
  );
}

main()
  .then(() => {
    // DELIBERATE DIVERGENCE from set-cca-flag.mjs, which this script
    // otherwise mirrors. abort() RETURNS rather than throwing (it only
    // sets process.exitCode), so an unconditional .then() prints
    //     *** ABORT: read-back mismatch: expected closed, got "open" ***
    //     Done.
    // one line apart. An operator who reads the last line of the output
    // walks away believing the freeze landed when it did not. The exit
    // code was always right; the human-readable summary was not.
    if (process.exitCode) return;
    console.log("\nDone.");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
