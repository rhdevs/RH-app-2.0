/**
 * Creates the `AuthAllowlist` collection and its TWO UNIQUE INDEXES.
 *
 *   node scripts/remediation/create-auth-allowlist.mjs             # dry run
 *   node scripts/remediation/create-auth-allowlist.mjs --commit    # apply
 *
 * Dry run by default. Under --commit it issues exactly two commands —
 * `create` and `createIndexes` — and then re-reads `listIndexes` and proves
 * the result rather than assuming it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT EXISTS INSTEAD OF `prisma db push`
 * ---------------------------------------------------------------------------
 *
 * `prisma/schema.prisma` now declares `model AuthAllowlist` with `@unique` on
 * both `email` and `pinnedUserID`. Three separate things follow from that, and
 * only two of them happen on their own:
 *
 *   1. The TYPED CLIENT appears by itself. `package.json`'s
 *      `"postinstall": "prisma generate"` runs on every Vercel build, and
 *      `prisma generate` reads the schema file only — it never touches the
 *      database. So `db.authAllowlist` exists at deploy with no migration.
 *   2. The COLLECTION appears by itself. MongoDB creates a collection lazily on
 *      first insert. (This script creates it explicitly anyway — see below.)
 *   3. THE INDEXES DO NOT APPEAR BY THEMSELVES, AND THIS IS THE WHOLE POINT.
 *      A Prisma `@unique` on a Mongo model is a CLIENT-SIDE TYPE ASSERTION.
 *      Until the index exists in the cluster, the database enforces nothing:
 *      two rows may carry the same `pinnedUserID`, and the `P2002` refusal in
 *      `admin.addAuthAllowlistEntry` — which is supposed to be how a duplicate
 *      pin is caught — can never fire, because Mongo never raises it.
 *
 * `prisma db push` would create those indexes. It would ALSO drop
 * `User.email_unique_ci`, the case-insensitive unique index that is the
 * duplicate-account guard, because Prisma cannot represent a collation index in
 * the schema and therefore sees it as "not in schema" and removes it — with no
 * warning and without needing --accept-data-loss. That hazard is written out in
 * prisma/schema.prisma, in the "⚠️ `prisma db push` DROPS" block of the comment
 * directly above `model User` — SEARCH FOR "email_unique_ci" rather than going
 * by a line number. (It sits around lines 934-946 today; that is a HINT and is
 * allowed to be stale. The previous citation here read `schema.prisma:877-887`,
 * and by the time anyone followed it line 877 was inside `model Restaurants`.)
 * It has been dropped and restored on this cluster before. So `db push` is
 * forbidden, and `createIndexes` is how the indexes get made.
 *
 * WITHOUT THESE TWO INDEXES, MECHANISM M3 DOES NOT EXIST. M3 is the one that
 * says a pin cannot be re-aimed: `pinnedUserID` unique means two emails cannot
 * share a pin, so a live privileged key cannot be quietly handed to a second
 * party while the first still holds it. M1 (the ':' makes the EXT and NUSNET
 * namespaces provably disjoint), M2 (`asExtUserID` re-validates at every read)
 * and M4 (adminProcedure + audited + three refusals) all still stand — but M3
 * is the only one of the four that is enforced by the DATABASE rather than by
 * code, and it is the only one that survives a bad write path. Skipping this
 * script leaves a silent hole. rbac-doctor.mjs's allowlist section detects it
 * FROM THE DATA (it asserts pin uniqueness directly) precisely because nobody
 * should have to remember to read `listIndexes`.
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
 * at the end is what decides the exit code: it re-reads `listIndexes` and
 * requires both indexes to exist with `unique: true`. A conflicting index is
 * therefore surfaced rather than swallowed.
 *
 * 11000 (E11000 duplicate key) is NOT idempotency and is NEVER swallowed. It
 * means rows already exist that violate the uniqueness being requested — the
 * index is not created, M3 still does not exist, and the data must be fixed
 * first. The dry run reads the existing rows and reports such duplicates in
 * advance so this is not a surprise.
 *
 * ---------------------------------------------------------------------------
 * $runCommandRaw RETURNS ERRORS AS DATA
 * ---------------------------------------------------------------------------
 *
 * This is the trap that makes an uninspected raw command worse than useless. A
 * failed command resolves as `{ ok: 0, code, errmsg }`, and a command whose
 * individual writes failed resolves as `{ ok: 1, writeErrors: [...] }` — a
 * `$jsonSchema` rejection arrives as `writeErrors[0].code === 121` with
 * `ok: 1`. Neither throws. A script built around try/catch alone reports
 * SUCCESS on a command that did nothing (see merge-by-canonical.mjs's note at
 * its survivor `$set`, and lib/rbac.mjs's `inspectWriteReply`). Every command
 * below goes through `runCmd`, which inspects the reply AND catches, and
 * `inspectWriteReply` is applied wherever writeErrors are possible.
 *
 * Run `node scripts/remediation/index-census.mjs` before and after this, and
 * diff the two. The only acceptable delta is the two indexes created here.
 */
import { PrismaClient } from "@prisma/client";
import { numify, inspectWriteReply, isCommit, banner, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

const COLL = "AuthAllowlist";

/**
 * The two indexes, spelled out exactly as they will be created. Names are
 * chosen and FIXED here: a name is what `IndexOptionsConflict` compares on, and
 * what a future operator greps the census for.
 */
const INDEXES = [
  { key: { email: 1 }, name: "email_unique", unique: true },
  { key: { pinnedUserID: 1 }, name: "pin_unique", unique: true },
];

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
 * Returns { ok, code, codeName, errmsg, reply, threw }.
 *
 * `ok: false` here means the COMMAND failed. Per-write failures (writeErrors)
 * are a separate axis and are inspected by the caller with inspectWriteReply —
 * `create` and `createIndexes` report failure at the command level, but the
 * distinction is kept explicit rather than assumed.
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

async function main() {
  banner("create-auth-allowlist.mjs", COMMIT);

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

  // -- 1. Existing rows, and whether they would VIOLATE the new indexes -----
  //
  // Read-only, and it exists so an E11000 under --commit is never a surprise.
  // If the collection already holds rows (someone hand-inserted in Atlas, or an
  // earlier partial rollout), a duplicate email or a duplicate pin makes
  // createIndexes FAIL — the index is not built, M3 still does not exist, and
  // the fix is in the DATA, not in this script.
  let rows = [];
  if (!before.absent) {
    const f = await runCmd({ find: COLL, filter: {}, limit: 1000, batchSize: 1000 }, "find");
    if (!f.ok) {
      return abort(`could not read existing ${COLL} rows: ${f.errmsg}`);
    }
    rows = f.reply?.cursor?.firstBatch ?? [];
  }
  console.log(`\n--- [1] existing rows ---`);
  console.log(`  ${COLL} documents: ${rows.length}`);
  const dup = (field) => {
    const seen = new Map();
    for (const r of rows) {
      const v = r?.[field];
      if (v === undefined) continue;
      seen.set(String(v), (seen.get(String(v)) ?? 0) + 1);
    }
    return [...seen].filter(([, n]) => n > 1).map(([v, n]) => `${JSON.stringify(v)} x${n}`);
  };
  const dupEmail = dup("email");
  const dupPin = dup("pinnedUserID");
  if (dupEmail.length || dupPin.length) {
    console.error(`  duplicate email:        ${dupEmail.join(", ") || "(none)"}`);
    console.error(`  duplicate pinnedUserID: ${dupPin.join(", ") || "(none)"}`);
    return abort(
      `existing rows already violate the uniqueness being requested. createIndexes ` +
        `would fail with E11000 and build NOTHING. Resolve the duplicate rows first — ` +
        `a duplicate pinnedUserID in particular means two addresses currently mint the ` +
        `SAME identity key, which is the exact state M3 exists to make impossible.`,
    );
  }
  if (rows.length) console.log(`  no duplicate email / pinnedUserID among them — safe to index`);

  // -- 2. Plan --------------------------------------------------------------
  const have = new Set((before.indexes ?? []).map((i) => String(i?.name ?? "")));
  console.log(`\n--- [2] plan ---`);
  console.log(
    `  ${COMMIT ? "+" : "~"} create collection ${COLL}` +
      `${before.absent ? "" : "   (already exists — will report NamespaceExists and continue)"}`,
  );
  for (const ix of INDEXES) {
    console.log(
      `  ${COMMIT ? "+" : "~"} createIndex ${ix.name.padEnd(14)} ${JSON.stringify(ix.key)} unique:true` +
        `${have.has(ix.name) ? "   (already present)" : ""}`,
    );
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing was created. Re-run with --commit to apply.`);
    console.log(
      `Then re-run \`node scripts/remediation/index-census.mjs\` and diff it against\n` +
        `the census you took beforehand. The ONLY acceptable delta is the two indexes\n` +
        `above; User.email_unique_ci must still be present.`,
    );
    return;
  }

  // -- 3. create ------------------------------------------------------------
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
  //
  // Both indexes in ONE command. Mongo builds them together and reports one
  // result, so there is no window in which `email` is unique and `pinnedUserID`
  // is not.
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
          `    unique:true explicitly and will fail if what exists is not what M3 needs.`,
      );
    }
  } else if (ci.code === 11000) {
    return abort(
      `E11000 while building the unique indexes: ${ci.errmsg}. Existing rows violate ` +
        `uniqueness, so NOTHING was built and M3 does not exist. Fix the data first.`,
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
  // reply.
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
    const got = after.indexes.find((i) => String(i?.name ?? "") === want.name);
    if (!got) {
      problems.push(`${want.name} is MISSING`);
      continue;
    }
    if (got.unique !== true) {
      problems.push(`${want.name} exists but unique=${JSON.stringify(got.unique)} — it enforces NOTHING`);
    }
    if (JSON.stringify(got.key ?? {}) !== JSON.stringify(want.key)) {
      problems.push(
        `${want.name} is on ${JSON.stringify(got.key ?? {})}, expected ${JSON.stringify(want.key)}`,
      );
    }
  }

  console.log(`\n================================`);
  if (problems.length) {
    for (const p of problems) console.error(`  RED  ${p}`);
    return abort(
      `the AuthAllowlist uniqueness guarantee (M3) is NOT in place. Do not provision ` +
        `any EXT account until this is resolved: without pin_unique, two addresses can ` +
        `be pinned to one identity key and admin.addAuthAllowlistEntry's P2002 refusal ` +
        `can never fire.`,
    );
  }
  console.log(`Both unique indexes are present and enforcing. M3 is live.`);
  console.log(
    `NOW re-run \`node scripts/remediation/index-census.mjs\` and diff it against the\n` +
      `census taken before this script. The ONLY acceptable delta is the two indexes\n` +
      `above. User.email_unique_ci MUST still be present.`,
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
