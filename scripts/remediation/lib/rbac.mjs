/**
 * Shared helpers for the RBAC v2 migration scripts (docs/plans/rbac/01, 06).
 *
 * WHY THIS FILE EXISTS. The plan snippets repeat findAll(), the legacyMirror
 * PRECEDENCE list and E_FORMAT inside six different scripts. Six copies of a
 * key-derivation rule is exactly the drift that invariant I-12 exists to
 * prevent, so they live here once. Nothing in this file connects to a database
 * on import; every function takes the PrismaClient as an argument.
 *
 * NOTE ON E_FORMAT. The plan (01 Step 2) puts E_FORMAT in lib/identity.mjs.
 * It is here instead, deliberately: identity.mjs is the ELIGIBILITY module and
 * an E-format regex sitting next to isCanonicalResidentID is an invitation to
 * use it as an eligibility gate, which is L-27 — g.s_samuel@u.nus.edu is a real
 * account and gating on /^E\d{7}$/ would withhold its baseline permanently.
 * E_FORMAT validates GRANT TARGETS only. Never call it on a backfill population.
 */

/** Extended-JSON scalars come back as {$numberLong:"3"} etc. Same helper as
 *  merge-accounts.mjs:88 — raw replies are not plain numbers. */
export function numify(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object") {
    if (v.$numberLong != null) return Number(v.$numberLong);
    if (v.$numberInt != null) return Number(v.$numberInt);
    if (v.$numberDouble != null) return Number(v.$numberDouble);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Drain a raw cursor FULLY. `batchSize` is a request, not a guarantee: a single
 * `find` reply on ~515 User rows may be truncated, and a script that reads only
 * firstBatch silently backfills a prefix of the population and reports success.
 */
export async function findAll(db, collection, projection = {}) {
  const raw = (cmd) => db.$runCommandRaw(cmd);
  const out = [];
  let res = await raw({ find: collection, filter: {}, projection, batchSize: 1000 });
  out.push(...(res?.cursor?.firstBatch ?? []));
  let id = res?.cursor?.id;
  while (id && String(numify(id)) !== "0" && String(id) !== "0") {
    res = await raw({ getMore: id, collection, batchSize: 1000 });
    out.push(...(res?.cursor?.nextBatch ?? []));
    id = res?.cursor?.id;
  }
  return out;
}

/**
 * Aggregation-based count. The `count` command is deprecated on MongoDB 5.0+
 * and documented as potentially inaccurate — unacceptable for a gate on an
 * irreversible operation (06 §4.2).
 */
export async function countWhere(db, collection, filter) {
  const r = await db.$runCommandRaw({
    aggregate: collection,
    pipeline: [{ $match: filter }, { $count: "n" }],
    cursor: {},
  });
  return numify(r?.cursor?.firstBatch?.[0]?.n);
}

/**
 * THE REVIEW FINDING, ENCODED ONCE.
 *
 * $runCommandRaw does NOT throw on a per-write failure. An `update` command
 * with a failing statement resolves with { ok: 1, n, nModified, upserted,
 * writeErrors: [...] }. Any try/catch built around it is dead code, and a batch
 * whose writeErrors are ignored reports success while leaving users with no
 * baseline. Every write in these scripts goes through this function.
 *
 * Returns { ok, n, nModified, upserted, writeErrors, writeConcernError }.
 */
export function inspectWriteReply(reply, label) {
  const writeErrors = reply?.writeErrors ?? [];
  const wce = reply?.writeConcernError ? [reply.writeConcernError] : [];
  const summary = {
    label,
    ok: numify(reply?.ok) === 1,
    n: numify(reply?.n),
    nModified: numify(reply?.nModified),
    upserted: reply?.upserted ?? [],
    writeErrors,
    writeConcernError: wce,
  };
  if (!summary.ok) {
    summary.writeErrors = [...writeErrors, { errmsg: `command ok=${JSON.stringify(reply?.ok)}`, index: -1 }];
  }
  return summary;
}

/** Role vocabulary. roles[] lives in a collection with NO $jsonSchema validator,
 *  so nothing but code constrains what strings land there (06 D1). */
export const ROLE_VOCAB = ["admin", "jcrc", "cca_head", "resident"];

/** Values legal in FacilityAccess.requiredRoles. A DIFFERENT enum from
 *  GRANTABLE_ROLES. "admin" is an implicit bypass and is NEVER stored. */
export const FACILITY_ROLES = ["resident", "jcrc", "cca_head"];

/**
 * Highest privilege first. Single source of truth for the legacy mirror.
 *
 * "resident" is deliberately ABSENT (06 §0.1). The only consumer of the mirror
 * is the pre-v2 access.ts, which is default-OPEN; writing "resident" into
 * FacilityAccess.requiredRole would make a Phase-2 revert DENY that room to
 * every non-admin. And roles[0] is NOT a substitute: it would mirror an
 * admin+jcrc user as "jcrc", silently demoting them on rollback.
 */
export const PRECEDENCE = ["admin", "jcrc", "cca_head"];
export const legacyMirror = (roles) => PRECEDENCE.find((r) => (roles ?? []).includes(r)) ?? "";

/** Same, but null-returning, for the restore path where "no scalar" is correct. */
export const legacyMirrorOrNull = (roles) => PRECEDENCE.find((r) => (roles ?? []).includes(r)) ?? null;

/** Validation of GRANT TARGETS only. Never an eligibility test (L-27). */
export const E_FORMAT = /^E\d{7}$/;

/** facilityID -1 is the sentinel filtered by Calender_v2.tsx:306. */
export const SENTINEL_FACILITY_ID = -1;

/** D-1: no row and an empty array both mean this, never "open to everyone". */
export const DEFAULT_REQUIRED_ROLES = ["resident"];

/**
 * The PRE-v2 derivation, kept ONLY so verify-canonical-rekey.mjs can compute
 * what the old key would have been. Unanchored, no .trim(), and .replace() hits
 * only the first literal occurrence — all three quirks are reproduced verbatim
 * because the orphan hunt is only correct if this is byte-identical to what
 * actually wrote the rows (src/server/auth.ts:135-137 pre-remediation).
 *
 * NEVER use this to derive a key for a write.
 */
export function legacyCanonicalUserID(email) {
  return String(email ?? "").toUpperCase().replace("@U.NUS.EDU", "");
}

/** Timestamps must be Extended JSON in a raw command; a JS Date serialises to
 *  a string and then compares wrong forever after. */
export const nowExt = () => ({ $date: new Date().toISOString() });

/** ISO stamp safe for a filename. */
export const fileStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Write flag. The task convention is an explicit `--commit` argv flag; doc 01
 * spells it APPLY=yes. Both are accepted and mean exactly the same thing, so a
 * command copy-pasted from either source behaves identically. ANYTHING else is
 * a read-only run.
 */
export function isCommit(argv = process.argv) {
  return argv.includes("--commit") || process.env.APPLY === "yes";
}

export function banner(name, commit) {
  console.log(`\n=== ${name} ===`);
  console.log(`MODE: ${commit ? "COMMIT (writing)" : "DRY RUN (no writes)"}`);
  console.log(`at:   ${new Date().toISOString()}\n`);
}

/** Print a refusal and mark the process failed. Returns false so callers can
 *  `if (!ok(...)) return;` without an extra branch. */
export function abort(msg) {
  console.error(`\n*** ABORT: ${msg} ***`);
  process.exitCode = 1;
  return false;
}
