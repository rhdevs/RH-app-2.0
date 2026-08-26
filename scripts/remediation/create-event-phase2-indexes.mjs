/**
 * Creates ONE named events-phase-2 collection and its COMPOUND UNIQUE INDEX.
 *
 * DO NOT RUN `prisma db push` INSTEAD OF THIS SCRIPT — NOT BEFORE IT, NOT AFTER
 * IT, NOT "JUST THIS ONCE TO GET THE INDEX".
 *
 * `prisma db push` would create both indexes below. It would ALSO drop
 * `User.email_unique_ci`, the case-insensitive unique index on `User.email`
 * that is the duplicate-account guard: Prisma cannot represent a collation
 * index in `schema.prisma`, so every push classifies it as not-in-schema and
 * removes it — with no warning and without needing `--accept-data-loss`. It has
 * been dropped and restored on this cluster before, and the remediation trail
 * is four scripts long (merge-by-canonical.mjs, fix-claresta-duplicate.mjs,
 * fix-lgd-duplicate.mjs, merge-mingyuan-duplicate.mjs). The prohibition is in
 * this heading rather than in a footnote for the reason set-events-flag.mjs
 * gives at its own retraction: an operator skimming a header for the command to
 * run will run the command the header names, and a note two paragraphs later
 * saying "actually, don't" does not survive a skim.
 *
 * The database step for a Mongo field-only schema change is `npx prisma
 * generate`, and nothing else. Indexes are made HERE, with `createIndexes`
 * through `$runCommandRaw`.
 *
 *   node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion            # DRY RUN
 *   node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion --commit   # apply
 *   node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance --commit # PART C ONLY
 *
 * ---------------------------------------------------------------------------
 * THE TARGET IS NAMED ON THE COMMAND LINE AND THERE IS NO DEFAULT
 * ---------------------------------------------------------------------------
 *
 * PART B ONLY NEEDS `EventQuestion`. The `EventAttendance` entry ships in this
 * same file because the file is CREATED in PR 2 and Part C should not have to
 * edit it — but PR 2 MUST NOT RUN IT. Two reasons, and both are about the
 * census diff being readable:
 *
 *   - PR 2's rollout step tells the operator the before/after census diff
 *     should show ONLY the `EventQuestion` lines. A script that also created
 *     `EventAttendance` would put lines in that diff which the operator was
 *     told to treat as a red flag — during the one step whose entire purpose is
 *     spotting unexpected index changes. The likely reaction is to stop a
 *     correct deploy; the worse one is to learn that this diff is noisy.
 *   - Part C's `EventAttendance` model does not exist yet. Creating an index on
 *     a collection whose model has not shipped puts a real index on the cluster
 *     that nothing reads, and makes PR 3's own census diff EMPTY — at which
 *     point verify-events-schema.mjs check [9] becomes blocking on the strength
 *     of a step that did nothing.
 *
 * So: named with NO argument, or with a name that is not one of the two, this
 * script prints usage and exits 2. It must never guess, and it must never do
 * both because somebody forgot to say which. (`process.exit(2)` on that one
 * path is deliberate and is the ONLY `process.exit` in the file: it happens
 * before any Prisma client work, so there is nothing to disconnect and nothing
 * buffered to flush. Everywhere after that, `process.exitCode`.)
 *
 * ---------------------------------------------------------------------------
 * WHY THE INDEXES MATTER — both failures are SILENT without them
 * ---------------------------------------------------------------------------
 *
 * EventQuestion {eventID:1, questionID:1} unique — `event_question`
 *   The save path's lock is advisory and reclaimable after 30s
 *   (services/events.ts). Without this index a stale-lock reclaim in the middle
 *   of a save writes TWO questions carrying the same `questionID`, and every
 *   answer to either one is then ambiguous. No error is raised anywhere.
 *
 * EventAttendance {eventID:1, userID:1} unique — `event_attendee`
 *   The unique index is what makes a re-scan idempotent: the second scan raises
 *   P2002, which `checkIn` turns into `alreadyCheckedIn`. Without it a double
 *   scan writes a second row, the count is wrong, the turnout percentage is
 *   wrong, and `undoCheckIn` deletes one of two. No error anywhere.
 *
 * A Prisma `@@unique` on a Mongo model is a CLIENT-SIDE TYPE ASSERTION. Until
 * the index exists in the cluster the database enforces nothing and the P2002
 * the router relies on can never fire, because Mongo never raises it.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT, AND WHAT "ALREADY PRESENT" MEANS
 * ---------------------------------------------------------------------------
 *
 * Re-running is safe. These replies are reported as "already present", NOT as
 * failures:
 *   48  NamespaceExists        the collection is already there
 *   68  IndexAlreadyExists     that index name is already there
 *   85  IndexOptionsConflict   same name, different options
 *   86  IndexKeySpecsConflict  same key, different name/options
 * An identical `createIndexes` normally just returns ok:1 with
 * numIndexesBefore == numIndexesAfter, so 85/86 mean somebody built a DIFFERENT
 * index under one of these names. That is reported loudly, and the VERIFY pass
 * at the end is what decides the exit code.
 *
 * 11000 (E11000 duplicate key) is NOT idempotency and is NEVER swallowed. It
 * means rows already exist that violate the uniqueness being requested — the
 * index is NOT created, the guarantee does not exist, and the DATA must be
 * fixed first. The dry run groups the existing rows on the index key and
 * reports such duplicates in advance so this is not a surprise under --commit.
 *
 * ---------------------------------------------------------------------------
 * $runCommandRaw RETURNS ERRORS AS DATA
 * ---------------------------------------------------------------------------
 *
 * This is the trap that makes an uninspected raw command worse than useless. A
 * failed command resolves as `{ ok: 0, code, errmsg }`, and a command whose
 * individual writes failed resolves as `{ ok: 1, writeErrors: [...] }`. NEITHER
 * THROWS. A script built around try/catch alone reports SUCCESS on a command
 * that did nothing — see create-auth-allowlist.mjs's note at the same place,
 * and lib/rbac.mjs's `inspectWriteReply`. Every command below goes through
 * `runCmd`, which inspects the reply AND catches.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT TOUCHES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * Exactly one collection: the one named on the command line. It issues `create`
 * and `createIndexes` against that name and `listIndexes` against that name,
 * and nothing else. It never touches `Event`, `EventSignup`, `User` or
 * `Counter`. If a diff of this file mentions any of those, it is the wrong
 * script.
 *
 * Run `node scripts/remediation/index-census.mjs > census-before.txt` before
 * this and again afterwards, and DIFF THE TWO. The only acceptable delta is the
 * two lines (`_id_` and the named unique index) for the ONE collection this run
 * targeted. Any REMOVED line is a dropped index and the cluster must take no
 * further writes until it is restored; `User.email_unique_ci` in particular
 * MUST still be present.
 */
import { PrismaClient } from "@prisma/client";
import { numify, inspectWriteReply, isCommit, banner, abort, aggregateAll } from "./lib/rbac.mjs";

/**
 * Every index this script is ever allowed to create, keyed by the collection
 * name the operator types. Names are chosen and FIXED here: a name is what
 * `IndexOptionsConflict` compares on, and what a future operator greps the
 * census for. The keys of this object ARE the accepted CLI vocabulary.
 */
const TARGETS = {
  EventQuestion: [
    { key: { eventID: 1, questionID: 1 }, name: "event_question", unique: true },
  ],
  EventAttendance: [
    { key: { eventID: 1, userID: 1 }, name: "event_attendee", unique: true },
  ],
};

const TARGET_NAMES = Object.keys(TARGETS);

function usage() {
  console.error(`\n*** create-event-phase2-indexes.mjs needs an explicit TARGET ***\n`);
  console.error(`Usage:`);
  console.error(`  node scripts/remediation/create-event-phase2-indexes.mjs <${TARGET_NAMES.join("|")}> [--commit]\n`);
  console.error(`  node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion            # DRY RUN`);
  console.error(`  node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion --commit   # PR 2 / Part B`);
  console.error(`  node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance --commit # PR 3 / Part C\n`);
  console.error(`There is NO default and there is no "all". PR 2 creates ONLY EventQuestion:`);
  console.error(`its census diff is supposed to show exactly the EventQuestion lines, and an`);
  console.error(`unexpected line in that diff is precisely the signal the diff exists to give.\n`);
}

// NO DEFAULT. An unrecognised or missing name exits 2 with usage — it must
// never silently fall back to "all". This runs BEFORE the PrismaClient below is
// used for anything, so `process.exit` here disconnects nothing and drops no
// buffered output; it is the one place in this file where it is allowed.
const target = process.argv[2];
if (!target || !(target in TARGETS)) {
  usage();
  process.exit(2);
}

const db = new PrismaClient();
const COMMIT = isCommit();

const COLL = target;
const INDEXES = TARGETS[COLL];

/** Replies that mean "someone got here first". See the header. */
const IDEMPOTENT_CODES = new Map([
  [48, "NamespaceExists — the collection already exists"],
  [68, "IndexAlreadyExists — that index name already exists"],
  [85, "IndexOptionsConflict — an index of that NAME exists with different options"],
  [86, "IndexKeySpecsConflict — an index on that KEY exists under a different name/options"],
]);

const NS_NOT_FOUND = 26;

/**
 * Run one raw command and normalise BOTH failure shapes into one value.
 * Returns { ok, code, codeName, errmsg, reply, threw, label }.
 *
 * `ok: false` here means the COMMAND failed. Per-write failures (writeErrors)
 * are a separate axis and are inspected by the caller with inspectWriteReply.
 */
async function runCmd(cmd, label) {
  let reply;
  try {
    reply = await db.$runCommandRaw(cmd);
  } catch (e) {
    const msg = String(e?.message ?? e);
    // Best effort at recovering a numeric code from a thrown driver error. If
    // it cannot be recovered the command is reported as a plain failure — never
    // guessed into an idempotent one, because guessing here would mean
    // reporting "already present" over an index that does not exist.
    const m = /code[^0-9]{0,4}(\d{1,5})/i.exec(msg);
    return {
      ok: false,
      code: m ? Number(m[1]) : null,
      codeName: null,
      errmsg: msg,
      reply: null,
      threw: true,
      label,
    };
  }
  return {
    ok: numify(reply?.ok) === 1,
    code: reply?.code === undefined ? null : numify(reply.code),
    codeName: reply?.codeName ?? null,
    errmsg: reply?.errmsg === undefined ? null : String(reply.errmsg),
    reply,
    threw: false,
    label,
  };
}

/** listIndexes, tolerating an absent collection (which is the pre-run state). */
async function readIndexes() {
  const r = await runCmd({ listIndexes: COLL }, "listIndexes");
  if (!r.ok) {
    if (r.code === NS_NOT_FOUND || /ns does not exist|NamespaceNotFound/i.test(String(r.errmsg))) {
      return { absent: true, indexes: [] };
    }
    return { absent: false, indexes: null, error: r.errmsg };
  }
  return { absent: false, indexes: r.reply?.cursor?.firstBatch ?? [] };
}

function printIndexes(list) {
  if (list === null) return console.log(`  (unreadable)`);
  if (!list.length) return console.log(`  (none)`);
  for (const i of [...list].sort((a, b) => String(a?.name).localeCompare(String(b?.name)))) {
    const opts = { ...i };
    delete opts.name;
    delete opts.key;
    delete opts.v;
    delete opts.ns;
    console.log(
      `  ${String(i?.name ?? "(unnamed)").padEnd(26)} ${JSON.stringify(i?.key ?? {})}` +
        `${Object.keys(opts).length ? `  ${JSON.stringify(opts)}` : ""}`,
    );
  }
}

/**
 * Group the EXISTING rows on the index key and report any group with more than
 * one member. Read-only, and it exists so an E11000 under --commit is never a
 * surprise: if the collection already holds rows that violate the uniqueness
 * being requested, `createIndexes` FAILS and builds NOTHING, and the fix is in
 * the DATA, not in this script.
 *
 * Returns { ok, errmsg, dups } — `ok:false` means the read failed and the
 * question is UNANSWERED, which is never rendered as "no duplicates".
 */
async function findKeyDuplicates(ix) {
  const fields = Object.keys(ix.key);
  const groupId = Object.fromEntries(fields.map((f) => [f, `$${f}`]));
  const res = await aggregateAll(db, COLL, [
    { $group: { _id: groupId, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 50 },
  ]);
  if (!res.ok) return { ok: false, errmsg: res.errmsg, dups: [] };
  return {
    ok: true,
    errmsg: null,
    dups: res.rows.map((r) => `${JSON.stringify(r?._id ?? {})} x${numify(r?.n)}`),
  };
}

async function main() {
  banner(`create-event-phase2-indexes.mjs  TARGET=${COLL}`, COMMIT);
  console.log(`This run touches ONE collection: ${COLL}. Nothing else, in either mode.\n`);

  // -- 0. BEFORE ------------------------------------------------------------
  console.log(`--- [0] ${COLL} indexes BEFORE ---`);
  const before = await readIndexes();
  if (before.absent) {
    console.log(`  collection ABSENT — this is the expected pre-rollout state`);
  } else if (before.indexes === null) {
    return abort(`could not read ${COLL} indexes: ${before.error}`);
  } else {
    printIndexes(before.indexes);
  }

  // -- 1. Existing rows, and whether they would VIOLATE the new index -------
  console.log(`\n--- [1] existing rows vs the uniqueness being requested ---`);
  if (before.absent) {
    console.log(`  ${COLL} does not exist yet — no rows, nothing can violate anything.`);
  } else {
    for (const ix of INDEXES) {
      const d = await findKeyDuplicates(ix);
      if (!d.ok) {
        return abort(
          `could not group ${COLL} on ${JSON.stringify(ix.key)}: ${d.errmsg}. ` +
            `The question "would this index build?" is UNANSWERED, and an unanswered ` +
            `question is not a "no duplicates". Resolve the read first.`,
        );
      }
      if (d.dups.length) {
        console.error(`  duplicates on ${JSON.stringify(ix.key)}: ${d.dups.join(", ")}`);
        return abort(
          `existing ${COLL} rows already violate the uniqueness being requested. ` +
            `createIndexes would fail with E11000 and build NOTHING. Fix the DATA first — ` +
            `deleting the wrong duplicate here silently rebinds answers, so do it by hand ` +
            `with the rows in front of you.`,
        );
      }
      console.log(`  no duplicate ${JSON.stringify(ix.key)} among the existing rows — safe to index`);
    }
  }

  // -- 2. Plan --------------------------------------------------------------
  const have = new Set((before.indexes ?? []).map((i) => String(i?.name ?? "")));
  console.log(`\n--- [2] plan ---`);
  console.log(
    `  ${COMMIT ? "+" : "~"} create collection ${COLL}` +
      `${before.absent ? "" : "   (already exists — will report NamespaceExists and continue)"}`,
  );
  for (const ix of INDEXES) {
    console.log(
      `  ${COMMIT ? "+" : "~"} createIndex ${ix.name.padEnd(16)} ${JSON.stringify(ix.key)} unique:true` +
        `${have.has(ix.name) ? "   (already present)" : ""}`,
    );
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing was created. Re-run with --commit to apply.`);
    console.log(
      `Then re-run \`node scripts/remediation/index-census.mjs\` and diff it against\n` +
        `the census you took beforehand. The ONLY acceptable delta is ${COLL}'s\n` +
        `_id_ and ${INDEXES.map((i) => i.name).join(" / ")}; User.email_unique_ci must still be present.`,
    );
    return;
  }

  // -- 3. create ------------------------------------------------------------
  //
  // Mongo would create the collection implicitly on createIndexes. The explicit
  // `create` is here so a RE-RUN reports `48 NamespaceExists`, which is a
  // clearer signal to the operator than silence.
  console.log(`\n--- [3] create ---`);
  const c = await runCmd({ create: COLL }, "create");
  if (c.ok) {
    console.log(`  created collection ${COLL}`);
  } else if (IDEMPOTENT_CODES.has(c.code)) {
    console.log(`  already present: ${IDEMPOTENT_CODES.get(c.code)} (code ${c.code})`);
  } else {
    // Not fatal on its own — createIndexes creates the collection implicitly —
    // but it must be reported rather than silently absorbed, because an
    // unexpected failure here (auth, quota, a locked namespace) is very likely
    // to make the next command fail too, and the VERIFY pass is what decides.
    console.error(
      `  ! create FAILED: code=${c.code} codeName=${c.codeName} errmsg=${c.errmsg}` +
        `${c.threw ? " (thrown, not returned)" : ""}`,
    );
    console.error(`    continuing to createIndexes — VERIFY below is the authority.`);
  }

  // -- 4. createIndexes -----------------------------------------------------
  console.log(`\n--- [4] createIndexes ---`);
  const ci = await runCmd({ createIndexes: COLL, indexes: INDEXES }, "createIndexes");
  if (ci.ok) {
    const b = numify(ci.reply?.numIndexesBefore);
    const a = numify(ci.reply?.numIndexesAfter);
    console.log(`  ok — numIndexesBefore=${b} numIndexesAfter=${a}`);
    if (ci.reply?.note) console.log(`  note: ${String(ci.reply.note)}   (already present)`);
    // Belt and braces: createIndexes reports at the command level, but if a
    // future server version ever reports per-index failures this catches them
    // rather than reading ok:1 as done.
    const w = inspectWriteReply(ci.reply, "createIndexes");
    if (w.writeErrors.length) {
      console.error(`  ! writeErrors: ${JSON.stringify(w.writeErrors)}`);
    }
  } else if (IDEMPOTENT_CODES.has(ci.code)) {
    console.log(`  already present: ${IDEMPOTENT_CODES.get(ci.code)} (code ${ci.code})`);
    if (ci.code === 85 || ci.code === 86) {
      console.error(
        `    WARNING: a CONFLICTING index exists — same name or same key, different\n` +
          `    options. That is not the same as "already correct". VERIFY below checks\n` +
          `    the KEY PATTERN and unique:true explicitly and will fail if what exists\n` +
          `    is not what this collection needs.`,
      );
    }
  } else if (ci.code === 11000) {
    // NEVER swallowed. This is not idempotency; it is the data telling you the
    // constraint is already violated.
    return abort(
      `E11000 while building the unique index on ${COLL}: ${ci.errmsg}. Existing rows ` +
        `violate uniqueness, so NOTHING was built and the guarantee does not exist. ` +
        `Fix the data first, then re-run this script.`,
    );
  } else {
    console.error(
      `  ! createIndexes FAILED: code=${ci.code} codeName=${ci.codeName} errmsg=${ci.errmsg}` +
        `${ci.threw ? " (thrown, not returned)" : ""}`,
    );
  }

  // -- 5. VERIFY ------------------------------------------------------------
  //
  // The reply above is a claim; this is the measurement. Every path through
  // this script lands here, including the "already present" ones, so the exit
  // code always reflects the state of the CLUSTER and never the shape of a
  // reply. It checks ONLY the target it was given.
  //
  // MATCHED ON THE KEY PATTERN, NEVER ON THE NAME. `prisma db push` and a
  // hand-run `createIndexes` produce DIFFERENT names for the same index, so a
  // name match reports a false failure on an index that is present and working
  // — the rule verify-events-schema.mjs:152 already states. Field ORDER is
  // significant: for a compound index the order IS the index's meaning.
  console.log(`\n=== VERIFY: ${COLL} indexes AFTER ===`);
  const after = await readIndexes();
  if (after.absent) {
    return abort(`${COLL} still does not exist. Nothing was created.`);
  }
  if (after.indexes === null) {
    return abort(`could not read ${COLL} indexes back: ${after.error}`);
  }
  printIndexes(after.indexes);

  const problems = [];
  for (const want of INDEXES) {
    const wantFields = Object.keys(want.key);
    const got = after.indexes.find((i) => {
      const keys = Object.keys(i?.key ?? {});
      return keys.length === wantFields.length && keys.every((k, n) => k === wantFields[n]);
    });
    if (!got) {
      problems.push(
        `no index on the key pattern ${JSON.stringify(want.key)} (wanted name "${want.name}") — MISSING`,
      );
      continue;
    }
    if (got.unique !== true) {
      problems.push(
        `an index on ${JSON.stringify(want.key)} exists (name "${String(got.name)}") but ` +
          `unique=${JSON.stringify(got.unique)} — it enforces NOTHING`,
      );
    }
  }

  console.log(`\n================================`);
  if (problems.length) {
    for (const p of problems) console.error(`  RED  ${p}`);
    return abort(
      `${COLL}'s uniqueness guarantee is NOT in place. Do not ship the feature that ` +
        `depends on it: a Prisma @@unique on Mongo enforces nothing on its own, so the ` +
        `P2002 the router relies on can never fire and the duplicate is written SILENTLY.`,
    );
  }
  console.log(`${COLL}: every requested unique index is present and enforcing.`);
  console.log(
    `\nNOW re-run \`node scripts/remediation/index-census.mjs\` and diff it against the\n` +
      `census taken before this script. The ONLY acceptable delta is ${COLL}'s lines.\n` +
      `User.email_unique_ci MUST still be present. Then run verify-events-schema.mjs.`,
  );
}

main()
  // Conditional on the exit code: printing "Done." under an ABORT banner is how
  // an operator skim-reads a refusal as a success.
  .then(() => console.log(process.exitCode ? "\nAborted — see above." : "\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
