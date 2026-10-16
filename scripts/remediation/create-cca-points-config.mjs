/**
 * Creates the `CcaPointsConfig` collection and its UNIQUE INDEX on `scope`.
 *
 *   node scripts/remediation/create-cca-points-config.mjs             # dry run
 *   node scripts/remediation/create-cca-points-config.mjs --commit    # apply
 *
 * Dry run by default. Under --commit it issues exactly two commands — `create`
 * and `createIndexes` — then re-reads `listIndexes` and proves the result.
 *
 * WHY THIS SCRIPT AND NOT `prisma db push`: `schema.prisma` declares
 * `scope String? @unique`, but on Mongo that is a client-side assertion; the
 * index only exists once it is built here. `db push` would build it AND drop
 * `User.email_unique_ci` (the duplicate-account guard), which Prisma cannot
 * represent. See scripts/remediation/README.md "Step 0" and the long header of
 * create-auth-allowlist.mjs, whose pattern this copies. The typed client
 * (`db.ccaPointsConfig`) comes from `npx prisma generate`, which never touches
 * the database.
 *
 * WITHOUT `scope_unique`, two rows can claim scope "default" (or the same
 * waiver), and which one the app reads becomes undefined. The unique index is
 * the only thing that makes the upserts in routers/ccaPoints.ts one-row-per-
 * scope.
 *
 * IDEMPOTENT. These replies count as "already present", not failures:
 *   48 NamespaceExists, 68 IndexAlreadyExists, 85 IndexOptionsConflict,
 *   86 IndexKeySpecsConflict.
 * 85/86 mean a DIFFERENT index sits under that name/key; the VERIFY pass at the
 * end decides the exit code by re-reading `listIndexes` and requiring
 * unique:true. 11000 (duplicate key) is NEVER swallowed: existing rows already
 * break uniqueness and the data must be fixed first. The dry run reports such
 * duplicates in advance.
 *
 * $runCommandRaw RETURNS ERRORS AS DATA ({ ok: 0 } resolves, it does not
 * throw), so every command goes through `runCmd`, which inspects the reply AND
 * catches.
 *
 * Run `node scripts/remediation/index-census.mjs` before and after and diff:
 * the only acceptable delta is `scope_unique` on CcaPointsConfig.
 *
 * Needs the environment loaded first (Prisma does not auto-load .env here):
 *   set -a && . ./.env >/dev/null 2>&1 && set +a && node scripts/remediation/create-cca-points-config.mjs
 */
import { PrismaClient } from "@prisma/client";
import { numify, isCommit, banner, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

const COLL = "CcaPointsConfig";
const INDEXES = [{ key: { scope: 1 }, name: "scope_unique", unique: true }];

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

/** One raw command; normalises both failure shapes (thrown and returned). */
async function runCmd(cmd, label) {
  let reply;
  try {
    reply = await db.$runCommandRaw(cmd);
  } catch (e) {
    const msg = String(e?.message ?? e);
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

async function readIndexes() {
  const r = await runCmd({ listIndexes: COLL }, "listIndexes");
  if (!r.ok) {
    if (
      r.code === NS_NOT_FOUND ||
      /ns does not exist|NamespaceNotFound/i.test(String(r.errmsg))
    ) {
      return { absent: true, indexes: [] };
    }
    return { absent: false, indexes: null, error: r.errmsg };
  }
  return { absent: false, indexes: r.reply?.cursor?.firstBatch ?? [] };
}

function printIndexes(list) {
  if (list === null) return console.log("  (unreadable)");
  if (!list.length) return console.log("  (none)");
  for (const i of [...list].sort((a, b) =>
    String(a?.name).localeCompare(String(b?.name)),
  )) {
    console.log(
      `  ${String(i?.name ?? "(unnamed)").padEnd(26)} ${JSON.stringify(i?.key ?? {})}${i?.unique ? "  unique" : ""}`,
    );
  }
}

async function main() {
  banner("create-cca-points-config.mjs", COMMIT);

  console.log(`--- [0] ${COLL} indexes BEFORE ---`);
  const before = await readIndexes();
  if (before.absent)
    console.log("  collection ABSENT — the expected pre-rollout state");
  else if (before.indexes === null)
    return abort(`could not read ${COLL} indexes: ${before.error}`);
  else printIndexes(before.indexes);

  // Existing rows that would violate the unique index (read-only).
  let rows = [];
  if (!before.absent) {
    const f = await runCmd(
      { find: COLL, filter: {}, limit: 1000, batchSize: 1000 },
      "find",
    );
    if (!f.ok)
      return abort(`could not read existing ${COLL} rows: ${f.errmsg}`);
    rows = f.reply?.cursor?.firstBatch ?? [];
  }
  console.log(
    `\n--- [1] existing rows ---\n  ${COLL} documents: ${rows.length}`,
  );
  const seen = new Map();
  for (const r of rows) {
    if (r?.scope === undefined || r?.scope === null) continue;
    seen.set(String(r.scope), (seen.get(String(r.scope)) ?? 0) + 1);
  }
  const dup = [...seen]
    .filter(([, n]) => n > 1)
    .map(([v, n]) => `${JSON.stringify(v)} x${n}`);
  if (dup.length) {
    console.error(`  duplicate scope: ${dup.join(", ")}`);
    return abort(
      "existing rows already violate uniqueness; createIndexes would fail with E11000. Fix the duplicate rows first.",
    );
  }

  const have = new Set(
    (before.indexes ?? []).map((i) => String(i?.name ?? "")),
  );
  console.log("\n--- [2] plan ---");
  console.log(
    `  ${COMMIT ? "+" : "~"} create collection ${COLL}${before.absent ? "" : "   (already exists)"}`,
  );
  for (const ix of INDEXES) {
    console.log(
      `  ${COMMIT ? "+" : "~"} createIndex ${ix.name} ${JSON.stringify(ix.key)} unique:true${have.has(ix.name) ? "   (already present)" : ""}`,
    );
  }
  if (!COMMIT) {
    console.log(
      "\nDRY RUN — nothing was created. Re-run with --commit to apply.",
    );
    return;
  }

  console.log("\n--- [3] create ---");
  const c = await runCmd({ create: COLL }, "create");
  if (c.ok)
    console.log(
      before.absent
        ? `  created collection ${COLL}`
        : `  collection ${COLL} already exists — left as is`,
    );
  else if (IDEMPOTENT_CODES.has(c.code))
    console.log(
      `  already present: ${IDEMPOTENT_CODES.get(c.code)} (code ${c.code})`,
    );
  else
    console.error(
      `  ! create FAILED: code=${c.code} errmsg=${c.errmsg} — continuing; VERIFY below is the authority.`,
    );

  console.log("\n--- [4] createIndexes ---");
  const ci = await runCmd(
    { createIndexes: COLL, indexes: INDEXES },
    "createIndexes",
  );
  if (ci.ok) {
    console.log(
      `  ok — numIndexesBefore=${numify(ci.reply?.numIndexesBefore)} numIndexesAfter=${numify(ci.reply?.numIndexesAfter)}`,
    );
  } else if (IDEMPOTENT_CODES.has(ci.code)) {
    console.log(
      `  already present: ${IDEMPOTENT_CODES.get(ci.code)} (code ${ci.code})`,
    );
    if (ci.code === 85 || ci.code === 86)
      console.error(
        "    WARNING: a CONFLICTING index exists. VERIFY below checks unique:true explicitly.",
      );
  } else if (ci.code === 11000) {
    return abort(
      `E11000 while building the unique index: ${ci.errmsg}. Existing rows violate uniqueness; nothing was built.`,
    );
  } else {
    console.error(
      `  ! createIndexes FAILED: code=${ci.code} errmsg=${ci.errmsg}`,
    );
  }

  console.log(`\n=== VERIFY: ${COLL} indexes AFTER ===`);
  const after = await readIndexes();
  if (after.absent)
    return abort(`${COLL} still does not exist. Nothing was created.`);
  if (after.indexes === null)
    return abort(`could not read ${COLL} indexes back: ${after.error}`);
  printIndexes(after.indexes);

  const problems = [];
  for (const want of INDEXES) {
    const got = after.indexes.find((i) => String(i?.name ?? "") === want.name);
    if (!got) problems.push(`${want.name} is MISSING`);
    else {
      if (got.unique !== true)
        problems.push(
          `${want.name} exists but unique=${JSON.stringify(got.unique)} — it enforces NOTHING`,
        );
      if (JSON.stringify(got.key ?? {}) !== JSON.stringify(want.key))
        problems.push(
          `${want.name} is on ${JSON.stringify(got.key ?? {})}, expected ${JSON.stringify(want.key)}`,
        );
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`  RED  ${p}`);
    return abort("the CcaPointsConfig uniqueness guarantee is NOT in place.");
  }
  console.log("\nThe unique index is present and enforcing.");
}

main()
  .then(() =>
    console.log(process.exitCode ? "\nAborted — see above." : "\nDone."),
  )
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
