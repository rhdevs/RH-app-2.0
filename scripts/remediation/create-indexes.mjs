/**
 * Creates the indexes that `prisma db push` MUST NOT be used to create on this
 * cluster. One collection per run, named on the command line.
 *
 *   CredentialRevocation  unique index on `userId`
 *                         — the database half of password-reset session
 *                           revocation (see schema.prisma and src/server/auth.ts).
 *   RateLimit             TTL index on `expiresAt`
 *                         — the only thing that ever deletes a rate-limit
 *                           bucket. Prisma cannot express a TTL index at all.
 *   Bookings              index on `seriesID`
 *                         — recurring-booking fan-out. This one IS expressible
 *                           in schema.prisma (`@@index([seriesID])`), and is
 *                           here anyway for the single reason below: the only
 *                           tool that would apply it is `db push`, and `db push`
 *                           drops User.email_unique_ci.
 *
 * DO NOT RUN `prisma db push` INSTEAD OF THIS SCRIPT — NOT BEFORE IT, NOT AFTER
 * IT, NOT "JUST THIS ONCE TO GET THE INDEX".
 *
 * `prisma db push` would create the unique index below and WOULD NOT create the
 * TTL one (Prisma cannot represent a TTL index at all). It would ALSO drop
 * `User.email_unique_ci`, the case-insensitive unique index on `User.email`
 * that is the duplicate-account guard: Prisma cannot represent a collation
 * index in `schema.prisma`, so every push classifies it as not-in-schema and
 * removes it — with no warning and without needing `--accept-data-loss`. It has
 * been dropped and restored on this cluster before, and the remediation trail
 * is four scripts long. The prohibition is in this heading and not in a
 * footnote, for the reason create-event-phase2-indexes.mjs gives at the same
 * place: an operator skimming a header for the command to run will run the
 * command the header names.
 *
 * The schema step for a Mongo model-only change is `npx prisma generate`, and
 * nothing else. Indexes are made HERE, with `createIndexes` through
 * `$runCommandRaw`.
 *
 *   node scripts/remediation/create-indexes.mjs CredentialRevocation           # DRY RUN
 *   node scripts/remediation/create-indexes.mjs CredentialRevocation --commit  # apply
 *   node scripts/remediation/create-indexes.mjs RateLimit --commit             # apply
 *
 * ---------------------------------------------------------------------------
 * URGENCY — THE APP WORKS WITHOUT EITHER INDEX, AND NEITHER IS A LOCKOUT RISK
 * ---------------------------------------------------------------------------
 *
 * BE PRECISE ABOUT THIS, because it decides whether the deploy has to wait.
 *
 * CredentialRevocation — MongoDB creates a collection lazily on first write, so
 *   revocation FUNCTIONS the moment the code deploys: the reset route's
 *   `upsert` creates the collection and the session callback reads it back.
 *   What is missing without the index is ENFORCEMENT of `userId @unique`, which
 *   on Mongo is otherwise a CLIENT-SIDE TYPE ASSERTION ONLY. Two concurrent
 *   resets for one account can then write two watermark rows, and `findUnique`
 *   returns whichever the driver reaches first — if that is the OLDER row, a
 *   session the newer one should have revoked is admitted.
 *
 * RateLimit — the limiter is correct without it; the collection simply never
 *   shrinks. This is a storage-growth fix, not a correctness one.
 *
 * So: run both in the same maintenance window as the deploy, and do not hold
 * the deploy for either.
 *
 * ---------------------------------------------------------------------------
 * $runCommandRaw RETURNS ERRORS AS DATA
 * ---------------------------------------------------------------------------
 *
 * A failed command resolves as `{ ok: 0, code, errmsg }`, and a command whose
 * individual writes failed resolves as `{ ok: 1, writeErrors: [...] }`. NEITHER
 * THROWS. A script built around try/catch alone reports SUCCESS on a command
 * that did nothing. Every command below goes through `runCmd`, which inspects
 * the reply AND catches.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT TOUCHES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * Exactly ONE collection per run: the one named on the command line. It issues
 * `create`, `createIndexes`, `listIndexes` and one read-only `aggregate`
 * against that name and nothing else. It never touches `User`, `UserRole` or
 * `PasswordResetSession`. If a diff of this file mentions any of those, it is
 * the wrong script.
 *
 * Run `node scripts/remediation/index-census.mjs > census-before.txt` before
 * this and again afterwards, and DIFF THE TWO. The only acceptable delta is the
 * lines for the ONE collection this run targeted. Any REMOVED line is a dropped
 * index and the cluster must take no further writes until it is restored;
 * `User.email_unique_ci` in particular MUST still be present.
 */
import { PrismaClient } from "@prisma/client";
import { isCommit, banner } from "./lib/rbac.mjs";

/**
 * Every index this script is ever allowed to create, keyed by the collection
 * name the operator types. Names are chosen and FIXED here: a name is what
 * `IndexOptionsConflict` compares on, and what a future operator greps the
 * census for. The keys of this object ARE the accepted CLI vocabulary.
 */
const TARGETS = {
  CredentialRevocation: [
    { key: { userId: 1 }, name: "credential_revocation_user", unique: true },
  ],
  /**
   * A TTL INDEX, AND THE ONLY THING THAT EVER DELETES A RateLimit ROW.
   *
   * `expiresAt` was a LOGICAL expiry only: the limiter compares against it, but
   * nothing removes the document, so the collection grew without bound and had
   * done since it was introduced. Every bucket key is at least partly
   * attacker-chosen — `reset:<email>` and now `login:email:<email>` are minted
   * for addresses that need not exist — so the growth is not proportional to
   * the number of real users, it is proportional to how long someone cares to
   * keep making requests. The per-IP budget bounds the RATE, never the TOTAL.
   *
   * `expireAfterSeconds: 0` means "delete when the date in the indexed field
   * has passed", which is exactly the semantics `expiresAt` already carries;
   * this makes the field's stated meaning true rather than aspirational.
   *
   * IT IS COMPATIBLE WITH THE LIMITER'S STEP 2. `rateLimit()` looks for an
   * EXPIRED row to roll forward into a fresh window. If the TTL reaper removed
   * it first, that step matches nothing and the create in step 3 handles it —
   * same outcome, one extra write. MongoDB's reaper runs about once a minute,
   * so in practice step 2 usually still finds the row.
   *
   * PRISMA CANNOT EXPRESS A TTL INDEX, which is why it is here and not in
   * schema.prisma — and which is also why `prisma db push` WOULD DROP IT, the
   * same way it drops `User.email_unique_ci`.
   */
  RateLimit: [
    { key: { expiresAt: 1 }, name: "ratelimit_ttl", expireAfterSeconds: 0 },
  ],
  /**
   * RECURRING BOOKINGS. `Bookings.seriesID` is null on every pre-existing row
   * and non-null only on occurrences of a repeating booking, so this index is
   * sparse in practice and cheap.
   *
   * NOT UNIQUE — the whole point is that many rows share one seriesID.
   *
   * WHAT NEEDS IT: `deleteSeries` scopes a cancel by `{ seriesID, userID }`, and
   * the My Bookings grouping fans a series out. Without the index those become
   * collection scans over every booking the hall has ever taken (~14k rows and
   * growing), on a user-facing path.
   */
  Bookings: [
    { key: { seriesID: 1 }, name: "series", unique: false },
    /**
     * CROSS-FACILITY OVERLAP — the index behind "which rooms are free between X
     * and Y": getFacilityAvailability, the availability board, and the
     * per-occurrence series preview.
     *
     * THIS ONE IS A PERFORMANCE FIX FOR AN ALREADY-HOT PATH, not a new
     * feature's index. None of the pre-existing indexes can serve those queries:
     * they constrain only startTime/endTime and deliberately do not filter by
     * facility, while `facility + time` leads with facilityID and is therefore
     * unusable with an unconstrained prefix. The query has always degraded to a
     * collection scan over every booking ever taken; what changed is that the
     * booking picker now runs it on a 350ms debounce as the user types a time.
     *
     * `endTime` LEADS DELIBERATELY. The overlap test is `startTime < windowEnd
     * AND endTime > windowStart`; the first half matches essentially all of
     * history, the second only bookings that have not finished. Leading with the
     * selective bound turns a scan into a range seek.
     */
    { key: { endTime: 1, startTime: 1 }, name: "time_overlap", unique: false },
  ],
};

const TARGET_NAMES = Object.keys(TARGETS);

function usage() {
  console.error(`
*** create-indexes.mjs needs an explicit TARGET ***
`);
  console.error(`Usage:`);
  console.error(
    `  node scripts/remediation/create-indexes.mjs <${TARGET_NAMES.join("|")}> [--commit]
`,
  );
  console.error(
    `  ... CredentialRevocation --commit   # unique index for the session-revocation watermark`,
  );
  console.error(
    `  ... RateLimit --commit              # TTL index so rate-limit buckets are actually reaped`,
  );
  console.error(
    `  ... Bookings --commit               # seriesID index for recurring bookings
`,
  );
  console.error(
    `There is NO default and there is no "all": each run should produce a census`,
  );
  console.error(
    `diff containing exactly one collection's lines, which is the whole point of`,
  );
  console.error(`taking the diff.
`);
}


// NO DEFAULT. Runs BEFORE the PrismaClient is used, so `process.exit` here
// disconnects nothing and drops no buffered output.
const target = process.argv[2];
if (!target || !(target in TARGETS)) {
  usage();
  process.exit(2);
}

const COLL = target;
const INDEXES = TARGETS[COLL];

/** Replies that mean "someone got here first". */
const IDEMPOTENT_CODES = new Map([
  [48, "NamespaceExists — the collection already exists"],
  [68, "IndexAlreadyExists — that index name already exists"],
  [
    85,
    "IndexOptionsConflict — an index of that NAME exists with different options",
  ],
  [
    86,
    "IndexKeySpecsConflict — an index on that KEY exists under a different name/options",
  ],
]);

const NS_NOT_FOUND = 26;

const db = new PrismaClient();
const COMMIT = isCommit();

/**
 * Run one raw command and normalise BOTH failure shapes into one value.
 * `ok: false` means the COMMAND failed; per-write failures are a separate axis.
 */
async function runCmd(cmd, label) {
  let reply;
  try {
    reply = await db.$runCommandRaw(cmd);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const m = /code(?:Name)?[":\s]+(\d+)/i.exec(msg);
    return {
      ok: false,
      code: m ? Number(m[1]) : null,
      errmsg: msg,
      threw: true,
      label,
    };
  }
  if (Number(reply?.ok) !== 1) {
    return {
      ok: false,
      code: reply?.code ?? null,
      errmsg: reply?.errmsg ?? "(no errmsg)",
      reply,
      threw: false,
      label,
    };
  }
  return { ok: true, reply, label };
}

/** Print the collection's current indexes, or say it does not exist yet. */
async function showIndexes(when) {
  const res = await runCmd({ listIndexes: COLL }, `listIndexes(${when})`);
  if (!res.ok) {
    if (res.code === NS_NOT_FOUND) {
      console.log(`  [${when}] collection does not exist yet`);
      return;
    }
    console.log(`  [${when}] could not list indexes: ${res.errmsg}`);
    return;
  }
  const batch = res.reply?.cursor?.firstBatch ?? [];
  for (const ix of batch) {
    const flags = ix.unique ? " UNIQUE" : "";
    console.log(`  [${when}] ${ix.name} ${JSON.stringify(ix.key)}${flags}`);
  }
}

async function main() {
  banner(`create-indexes [${COLL}]`, COMMIT);
  console.log(`Collection: ${COLL}`);
  for (const ix of INDEXES) {
    console.log(
      `Index:      ${ix.name} ${JSON.stringify(ix.key)}${ix.unique ? " UNIQUE" : ""}`,
    );
  }
  console.log("");

  await showIndexes("before");

  /* ---- DUPLICATE PRE-FLIGHT ------------------------------------------------
   * A unique index REFUSES TO BUILD if the data already violates it, and the
   * refusal arrives as a command failure under --commit. Surfacing it here
   * means the operator learns about a duplicate in the dry run, with the
   * offending userId named, rather than reading a DuplicateKey errmsg during
   * the apply. Skipped silently when the collection does not exist yet, which
   * is the expected state on a first run.
   */
  const uniqueIx = INDEXES.find((ix) => ix.unique);
  const dupes = !uniqueIx
    ? { ok: false, code: null, errmsg: "(skipped — no unique index in this target)" }
    : await runCmd(
    {
      aggregate: COLL,
      pipeline: [
        { $group: { _id: `$${Object.keys(uniqueIx.key)[0]}`, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $limit: 20 },
      ],
      cursor: {},
    },
    "duplicate pre-flight",
  );
  if (!uniqueIx) {
    console.log(`  [pre-flight] target has no unique index — duplicate check not applicable`);
  } else if (dupes.ok) {
    const rows = dupes.reply?.cursor?.firstBatch ?? [];
    if (rows.length > 0) {
      console.log(`\n*** ${rows.length} duplicate userId value(s) present ***`);
      for (const r of rows) console.log(`    ${r._id}  x${r.n}`);
      console.log(
        `A unique index cannot be built over these. Resolve them first — keep the`,
      );
      console.log(
        `row with the LATEST changedAt, which is the correct watermark, and delete`,
      );
      console.log(`the others.\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`  [pre-flight] no duplicate ${Object.keys(uniqueIx.key)[0]} values`);
  } else if (dupes.code !== NS_NOT_FOUND) {
    console.log(`  [pre-flight] could not check duplicates: ${dupes.errmsg}`);
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.\n`);
    return;
  }

  // `create` first so `createIndexes` has a namespace to work on. Code 48
  // (NamespaceExists) is the normal reply on a re-run and is not a failure.
  const created = await runCmd({ create: COLL }, `create ${COLL}`);
  if (created.ok) {
    console.log(`\n  created collection ${COLL}`);
  } else if (IDEMPOTENT_CODES.has(created.code)) {
    console.log(`\n  ${COLL}: ${IDEMPOTENT_CODES.get(created.code)}`);
  } else {
    console.error(`\n*** create ${COLL} failed: ${created.errmsg} ***`);
    process.exitCode = 1;
    return;
  }

  const made = await runCmd(
    { createIndexes: COLL, indexes: INDEXES },
    `createIndexes ${COLL}`,
  );
  if (made.ok) {
    const r = made.reply;
    console.log(
      `  createIndexes ok — before:${r?.numIndexesBefore} after:${r?.numIndexesAfter}`,
    );
    if (r?.note) console.log(`  note: ${r.note}`);
  } else if (IDEMPOTENT_CODES.has(made.code)) {
    // 85/86 are NOT clean successes — they mean an index of that name or key
    // exists with DIFFERENT options, so the one we wanted may not be there.
    // Reported, and the after-listing below is what settles it.
    console.log(`  ${IDEMPOTENT_CODES.get(made.code)}`);
    if (made.code === 85 || made.code === 86) {
      console.log(
        `  *** CHECK THE AFTER-LISTING: the existing index may not be UNIQUE ***`,
      );
      process.exitCode = 1;
    }
  } else {
    console.error(`\n*** createIndexes failed: ${made.errmsg} ***`);
    process.exitCode = 1;
  }

  console.log("");
  await showIndexes("after");
  console.log(
    `\nNow re-run index-census.mjs and diff it against the before-capture.`,
  );
  console.log(
    `The only acceptable delta is the ${COLL} lines. User.email_unique_ci MUST still be present.\n`,
  );
}

main()
  .catch((e) => {
    console.error(`\n*** UNCAUGHT: ${String(e?.message ?? e)} ***`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
