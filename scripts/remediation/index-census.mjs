/**
 * INDEX CENSUS. READ-ONLY — it issues `listCollections` and `listIndexes` and
 * nothing else. Both are reads that take no locks. There is no `--commit` flag
 * because there is no write path; passing one is refused.
 *
 *   node scripts/remediation/index-census.mjs
 *   node scripts/remediation/index-census.mjs > census-before.txt
 *
 * WHY THIS EXISTS AT ALL — read this before deciding it is a footnote.
 *
 * Prisma's Mongo connector cannot represent every index this cluster carries.
 * The one that matters most is `email_unique_ci` on `User`:
 *
 *   { key: {email:1}, name:"email_unique_ci", unique:true,
 *     collation:{locale:"en", strength:2} }
 *
 * It is the ONLY thing stopping two rows differing solely in letter case from
 * becoming two accounts for one human — the duplicate-account class this
 * repository has already had to remediate by hand (merge-by-canonical.mjs,
 * fix-*-duplicate.mjs). prisma/schema.prisma states the hazard explicitly, in
 * the "⚠️ `prisma db push` DROPS" block of the comment directly above
 * `model User` — SEARCH FOR "email_unique_ci"; do not go by a line number. (It
 * is around lines 934-946 today. That is a HINT and is allowed to rot: this
 * file used to cite `schema.prisma:877-887`, and line 877 has since become part
 * of `model Restaurants`, so an operator following a RED banner under time
 * pressure landed on a restaurant model.) `prisma db push` cannot see a
 * collation index in the schema, so it classifies it as "not in schema" and
 * DROPS IT — silently, and without needing --accept-data-loss. It has been
 * dropped and restored before.
 *
 * So the phase-2 rule is: NEVER run `prisma db push` or `prisma migrate` on
 * this cluster. The AuthAllowlist collection and its two unique indexes are
 * created explicitly with `createIndexes`, by create-auth-allowlist.mjs.
 *
 * THIS SCRIPT IS THE PROOF, NOT THE PROMISE. Run it BEFORE any
 * schema-adjacent operation and AGAIN afterwards, and DIFF THE TWO OUTPUTS.
 * The only acceptable delta for phase 2 is the two new AuthAllowlist indexes.
 * The repo documents `email_unique_ci` in one place; a document is a claim,
 * this is a measurement, and only the measurement counts on the day.
 *
 * IT CENSUSES THE WHOLE CLUSTER, NOT A LIST OF FAVOURITES. The collections are
 * DISCOVERED with `listCollections`, and every one of them is measured. This
 * used to be a hand-written list of 15 names, which meant `Facilities`,
 * `Account`, `Session`, `EventSignup` and `EventLock` were not in it — so a
 * dropped index on any of them was INVISIBLE to the before/after diff that the
 * entire `db push`-safety procedure rests on. A census that only looks where it
 * expects trouble is not a census. The hand-written list survives as EXPECTED
 * (below): a name on it that is missing from the cluster is still printed as
 * `(absent)`, and the ones that cannot legitimately be missing are flagged.
 *
 * OUTPUT IS DESIGNED TO BE DIFFED, which is why it is deliberately boring:
 *   - collections in SORTED order, so a collection appearing or disappearing
 *     inserts or removes one block and moves nothing else. (This was a fixed
 *     hand-written order for the same reason; sorting is what preserves the
 *     property now that the list is discovered and can grow.)
 *   - indexes within a collection sorted by name;
 *   - every option except `key` rendered with recursively SORTED keys, so a
 *     reply whose field order shifts between server versions still diffs clean;
 *   - `key` rendered in its ORIGINAL order, because for a compound index the
 *     field order is the index's meaning and sorting it would be a lie. This is
 *     the one deliberate exception to "sort everything".
 *
 * A MISSING COLLECTION PRINTS `(absent)` AND IS NOT AN ERROR. `AuthAllowlist`
 * is expected absent on the first run — that is the whole pre-rollout state.
 * A missing collection is distinguished from an empty index list, which cannot
 * happen (every collection has at least `_id_`).
 *
 * IF `listCollections` ITSELF FAILS the census falls back to the EXPECTED list
 * and marks the whole run PARTIAL with exit 1 — because a narrowed census that
 * does not say it was narrowed is exactly the false baseline this script is
 * supposed to be an antidote to.
 *
 * THE ONE RED LINE: `email_unique_ci` missing from `User`. That exits 1. If it
 * is gone, STOP and restore it before anything else touches this cluster:
 *
 *   db.runCommand({ createIndexes: "User", indexes: [{
 *     key: { email: 1 }, name: "email_unique_ci", unique: true,
 *     collation: { locale: "en", strength: 2 } }] })
 *
 * (the same one-liner appears inside that schema.prisma comment — search
 * "createIndexes" within the `email_unique_ci` block). Note it will FAIL with
 * E11000 if duplicates have already formed in the window it was absent — that
 * failure is the point, and merge-by-canonical.mjs is the remedy.
 */
import { PrismaClient } from "@prisma/client";
import { numify, isCommit, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();

/**
 * NOT the census population — the census is whatever `listCollections` reports.
 * This is the ASSERTION list: collections the phase-2 plan (F9) names, plus the
 * ones the auth stack depends on, each of which must show up in the output. A
 * name here that the cluster does not have is printed as `(absent)` and counted,
 * so its disappearance is visible rather than silent.
 *
 * Grouped by why each is here rather than alphabetised (the OUTPUT is sorted;
 * this list is documentation):
 *   identity + authz    User, UserRole, FacilityAccess, RoleAuditLog
 *   switches + sessions SystemFlag, PasswordResetSession
 *   next-auth adapter   Account, Session
 *   phase 2's new one   AuthAllowlist (expected ABSENT before the rollout)
 *   profile + grants    UserMatric, ProfileCompletion, PendingRoleGrant, CcaHead
 *   data the app joins  Facilities, Bookings, Posts, UserCCA, Event,
 *                       EventSignup, EventLock
 */
const EXPECTED = [
  "User",
  "UserRole",
  "FacilityAccess",
  "RoleAuditLog",
  "SystemFlag",
  "PasswordResetSession",
  "Account",
  "Session",
  "AuthAllowlist",
  "UserMatric",
  "ProfileCompletion",
  "PendingRoleGrant",
  "CcaHead",
  "Facilities",
  "Bookings",
  "Posts",
  "UserCCA",
  "Event",
  "EventSignup",
  "EventLock",
];

/**
 * The subset whose ABSENCE is a stop rather than a note.
 *
 * Deliberately short. `AuthAllowlist` is legitimately absent before step 19 and
 * `Account`/`Session` only exist once the next-auth adapter has written one, so
 * neither belongs here. These four have carried rows since phase 1 and are read
 * on the authenticated request path; if `listCollections` cannot see one of
 * them, either the census is looking at the wrong database or something has
 * gone very wrong, and both answers are reached faster by exiting 1 than by
 * printing `(absent)` into a diff.
 */
const MUST_EXIST = new Set(["User", "UserRole", "FacilityAccess", "RoleAuditLog"]);

/** The index this whole script exists to watch. */
const GUARD_COLLECTION = "User";
const GUARD_INDEX = "email_unique_ci";

/** Mongo's "namespace does not exist". Not an error here — see the header. */
const NS_NOT_FOUND = 26;

/**
 * Recursively key-sorted JSON. Two servers (or two driver versions) may hand
 * back the same option document with its fields in a different order; without
 * this, a census diff would light up on a difference that does not exist.
 * Used for OPTIONS ONLY — never for `key`, whose order is semantic.
 */
function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
}

/**
 * `listIndexes`, tolerant of BOTH failure shapes.
 *
 * $runCommandRaw does not have one error convention. A command the server
 * rejects can come back as DATA (`{ ok: 0, code, errmsg }`) or as a thrown
 * PrismaClientKnownRequestError depending on the failure. A reader that only
 * catches, or only inspects, mistakes one of them for success — and for a
 * census "success with no indexes" reads as a collection that has been
 * stripped bare, which is precisely the alarm this script is supposed to
 * raise honestly. So: try/catch AND inspect `ok`.
 *
 * Returns { state: "ok" | "absent" | "error", indexes, detail }.
 */
async function listIndexes(coll) {
  let reply;
  try {
    reply = await db.$runCommandRaw({ listIndexes: coll });
  } catch (e) {
    const msg = String(e?.message ?? e);
    // The thrown shape carries no structured code we can rely on, so match the
    // server's wording. Conservative: anything we cannot positively identify as
    // "namespace missing" is reported as an ERROR, never as an absence.
    if (/ns does not exist|NamespaceNotFound|Collection.*not found/i.test(msg)) {
      return { state: "absent", indexes: [], detail: msg };
    }
    return { state: "error", indexes: [], detail: `threw: ${msg}` };
  }
  if (numify(reply?.ok) !== 1) {
    const code = numify(reply?.code);
    if (code === NS_NOT_FOUND) {
      return { state: "absent", indexes: [], detail: String(reply?.errmsg ?? "") };
    }
    return {
      state: "error",
      indexes: [],
      detail: `ok=${JSON.stringify(reply?.ok)} code=${code} errmsg=${String(reply?.errmsg ?? "(none)")}`,
    };
  }
  return { state: "ok", indexes: reply?.cursor?.firstBatch ?? [], detail: "" };
}

/**
 * Every collection that actually exists, discovered rather than assumed.
 *
 * NO SERVER-SIDE `filter`, and that is not a style choice — the same Atlas quirk
 * preflight-scrc-validators.mjs documents: Atlas rejects
 * `filter: { name: { $in: [...] } }` with "Error code 8000 (AtlasError): can't
 * get regex from filter doc not a regex", because its listCollections filter
 * accepts an exact string or a regex on `name` and nothing else. Ask for
 * everything, narrow in JS. One round trip, read-only, and immune to the next
 * Atlas quirk.
 *
 * VIEWS AND SYSTEM NAMESPACES ARE EXCLUDED. A view has no indexes of its own, so
 * `listIndexes` against one fails — which would land in the `errors` list and
 * mark an otherwise clean census PARTIAL. `system.*` is server bookkeeping.
 *
 * Returns { ok, names, detail }. `ok:false` is a PARTIAL census, never an empty
 * one: a failed discovery must not be rendered as "the cluster has no
 * collections", which is the fabricated-zero class this file already refuses
 * elsewhere.
 */
async function listCollectionNames() {
  let reply;
  try {
    reply = await db.$runCommandRaw({ listCollections: 1 });
  } catch (e) {
    return { ok: false, names: [], detail: `threw: ${String(e?.message ?? e)}` };
  }
  if (numify(reply?.ok) !== 1) {
    return {
      ok: false,
      names: [],
      detail: `ok=${JSON.stringify(reply?.ok)} code=${numify(reply?.code)} errmsg=${String(reply?.errmsg ?? "(none)")}`,
    };
  }
  const batch = reply?.cursor?.firstBatch ?? [];
  const names = batch
    .filter((c) => (c?.type ?? "collection") === "collection")
    .map((c) => String(c?.name ?? ""))
    .filter((n) => n && !n.startsWith("system."));
  if (names.length === 0) {
    return { ok: false, names: [], detail: `listCollections returned no collections at all` };
  }
  return { ok: true, names, detail: "" };
}

/** One stable, diffable line per index. */
function renderIndex(coll, idx) {
  const name = String(idx?.name ?? "(unnamed)");
  // ORIGINAL order — a compound index's field order is its meaning.
  const key = JSON.stringify(idx?.key ?? {});
  const opts = { ...idx };
  // `v` is the index-format version and `ns` is echoed back by older servers;
  // both are server bookkeeping that would add pure noise to every diff.
  delete opts.name;
  delete opts.key;
  delete opts.v;
  delete opts.ns;
  const optKeys = Object.keys(opts).sort();
  const rendered = optKeys.map((k) => `${k}=${stableJson(opts[k])}`).join(" ");
  return `  ${coll.padEnd(22)} ${name.padEnd(26)} ${key}${rendered ? `  ${rendered}` : ""}`;
}

async function main() {
  // Defence in depth. Nothing below can write — the only command issued is
  // `listIndexes` — but an operator who typed --commit believes they are
  // running a migration, and printing a census under that belief invites them
  // to record it as the "after" of a step that never ran.
  if (isCommit()) {
    return abort(
      "index-census.mjs is READ-ONLY and has no write path. Drop --commit / APPLY=yes. " +
        "If you meant to CREATE the AuthAllowlist indexes, that is create-auth-allowlist.mjs.",
    );
  }

  console.log(`\n=== index-census.mjs (READ-ONLY) ===`);
  console.log(`at:   ${new Date().toISOString()}`);
  console.log(`Diff this against the run you took before/after the change.\n`);

  // DISCOVER, then union with EXPECTED. The union is what makes a MISSING
  // expected collection visible: discovery alone would simply not print it, and
  // a diff cannot show the absence of a line that was never going to be there.
  const disco = await listCollectionNames();
  const errors = [];
  if (!disco.ok) {
    console.error(`  *** listCollections FAILED — ${disco.detail}`);
    console.error(
      `  Falling back to the ${EXPECTED.length} EXPECTED collections. This census is\n` +
        `  PARTIAL: any collection outside that list is unmeasured, so it cannot be\n` +
        `  used as the before/after baseline for a schema-adjacent change.`,
    );
    errors.push(`listCollections: ${disco.detail}`);
  }
  const discovered = new Set(disco.names);

  // Sorted, so a new collection inserts one block and moves nothing else.
  const census = [...new Set([...disco.names, ...EXPECTED])].sort();
  const unexpected = census.filter((c) => discovered.has(c) && !EXPECTED.includes(c));

  console.log(`  collections discovered: ${disco.ok ? disco.names.length : "(discovery failed)"}`);
  console.log(`  collections censused:   ${census.length}  (discovered ∪ expected)\n`);
  console.log(`  ${"collection".padEnd(22)} ${"index".padEnd(26)} key  options`);
  console.log(`  ${"-".repeat(22)} ${"-".repeat(26)} ${"-".repeat(30)}`);

  let guardPresent = false;
  let guardLine = null;
  const absent = [];
  const missingRequired = [];
  let total = 0;

  for (const coll of census) {
    const r = await listIndexes(coll);

    if (r.state === "absent") {
      // NOT an error by default. AuthAllowlist is expected absent before step 19
      // of the rollout, and several of the others are droplet-owned collections
      // that may simply not exist on a given cluster.
      //
      // MUST_EXIST is the exception, and it is what keeps the widened census
      // from being purely additive: a name on the EXPECTED list that vanishes
      // from the cluster now produces a LINE (`(absent)`) rather than nothing at
      // all, and for these four it also stops the run.
      const required = MUST_EXIST.has(coll);
      console.log(`  ${coll.padEnd(22)} (absent)${required ? "   *** REQUIRED — see below" : ""}`);
      absent.push(coll);
      if (required) missingRequired.push(coll);
      continue;
    }
    if (r.state === "error") {
      // A command that FAILED must never be rendered as "no indexes". That is
      // the fabricated-zero class: it would read as a collection someone has
      // stripped, and send the operator to re-create indexes that are fine.
      console.log(`  ${coll.padEnd(22)} *** UNREADABLE — ${r.detail}`);
      errors.push(`${coll}: ${r.detail}`);
      continue;
    }

    // Sorted by name so the census does not reorder when Mongo does.
    const sorted = [...r.indexes].sort((a, b) =>
      String(a?.name ?? "").localeCompare(String(b?.name ?? "")),
    );
    if (sorted.length === 0) {
      // Not reachable in practice — every collection has `_id_` — so if it ever
      // prints, something is wrong with the READ, not with the collection.
      console.log(`  ${coll.padEnd(22)} *** ZERO INDEXES (impossible — every collection has _id_)`);
      errors.push(`${coll}: listIndexes returned an empty list`);
      continue;
    }
    for (const idx of sorted) {
      const lineText = renderIndex(coll, idx);
      console.log(lineText);
      total++;
      if (coll === GUARD_COLLECTION && String(idx?.name ?? "") === GUARD_INDEX) {
        guardPresent = true;
        guardLine = lineText.trim();
      }
    }
  }

  console.log(`\n--- summary ---`);
  console.log(`  collections discovered ...... ${disco.ok ? disco.names.length : "(discovery FAILED)"}`);
  console.log(`  collections censused ........ ${census.length}`);
  console.log(`  collections absent .......... ${absent.length}${absent.length ? `  [${absent.join(", ")}]` : ""}`);
  console.log(`  collections unreadable ...... ${errors.length}`);
  console.log(`  indexes counted ............. ${total}`);
  // Informational. A collection nobody thought to name is exactly the kind this
  // census was widened to cover, so seeing it listed is the feature working —
  // and a NEW name appearing here between two runs is itself worth a look.
  console.log(
    `  outside the expected list ... ${unexpected.length}${unexpected.length ? `  [${unexpected.join(", ")}]` : ""}`,
  );

  if (missingRequired.length) {
    console.error(`\n  *** RED: required collection(s) MISSING: ${missingRequired.join(", ")} ***`);
    console.error(
      `  These carry rows on the authenticated request path and cannot legitimately\n` +
        `  be absent. Either this census is pointed at the wrong database (check\n` +
        `  DATABASE_URL's db name) or something has removed them. Do not use this\n` +
        `  output as a baseline; resolve it first.`,
    );
    process.exitCode = 1;
  }

  console.log(`\n--- the guard index ---`);
  if (guardPresent) {
    console.log(`  OK   ${GUARD_COLLECTION}.${GUARD_INDEX} is PRESENT`);
    console.log(`       ${guardLine}`);
    console.log(
      `       This is the case-insensitive unique index on User.email. It is the\n` +
        `       duplicate-account guard, it is NOT representable in schema.prisma,\n` +
        `       and \`prisma db push\` DROPS IT without warning. Re-run this census\n` +
        `       after anything schema-adjacent and confirm this line is still here.`,
    );
  } else {
    console.error(`\n  *** RED: ${GUARD_COLLECTION}.${GUARD_INDEX} IS MISSING ***`);
    console.error(
      `  The case-insensitive unique index on User.email is GONE. Duplicate\n` +
        `  accounts differing only in letter case can be created RIGHT NOW, and\n` +
        `  nothing in the application will notice. The usual cause is that someone\n` +
        `  ran \`prisma db push\` — see prisma/schema.prisma, the "⚠️ prisma db push\n` +
        `  DROPS" block in the comment above \`model User\` (search: email_unique_ci).\n\n` +
        `  STOP. Restore it before any other work on this cluster:\n\n` +
        `    db.runCommand({ createIndexes: "User", indexes: [{\n` +
        `      key: { email: 1 }, name: "email_unique_ci", unique: true,\n` +
        `      collation: { locale: "en", strength: 2 } }] })\n\n` +
        `  If that fails with E11000, duplicates have ALREADY formed in the window\n` +
        `  it was absent. Do not force it — run merge-by-canonical.mjs (dry run\n` +
        `  first) to resolve them, then create the index.`,
    );
    process.exitCode = 1;
  }

  if (errors.length) {
    console.error(`\n  COMMANDS THAT FAILED (these are NOT measured absences):`);
    for (const e of errors) console.error(`      ${e}`);
    console.error(
      `  A census with a failed read is a PARTIAL census. Do not paste it into\n` +
        `  the PR as the before/after baseline until every line above resolves.`,
    );
    process.exitCode = 1;
  }

  if (!process.exitCode) {
    console.log(`\nCensus complete. Nothing was written.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
