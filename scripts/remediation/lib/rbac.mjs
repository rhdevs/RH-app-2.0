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
  // RANGE-PAGED over _id, NOT a server-side cursor.
  //
  // This used `find` followed by `getMore` on the returned cursor id. That is
  // the natural shape and it FAILS against a replica set: Prisma's
  // $runCommandRaw does not pin a connection or carry a session, so the
  // `getMore` can be routed to a different node than the `find` that opened the
  // cursor — which does not have it. The result is
  //   Error 43 (CursorNotFound): cursor id ... not found
  // partway through, i.e. exactly the truncated read the pagination was added
  // to prevent, but louder. Observed against Atlas on the very first inventory
  // run over ~515 User rows.
  //
  // Each page below is an INDEPENDENT `find`, so it does not matter which node
  // serves it. Ordering on _id gives a stable, gap-free walk without `skip`,
  // whose cost grows with the offset. `_id` is forced into the projection: a
  // caller that projects it away would otherwise silently loop on page one
  // forever.
  const PAGE = 1000;
  const proj =
    projection && Object.keys(projection).length ? { ...projection, _id: 1 } : {};
  const out = [];
  let after = null;

  for (;;) {
    const filter = after ? { _id: { $gt: after } } : {};
    const res = await db.$runCommandRaw({
      find: collection,
      filter,
      projection: proj,
      sort: { _id: 1 },
      limit: PAGE,
      // No getMore is ever issued, so a truncated firstBatch cannot silently
      // end the walk: the page is short only when the collection is exhausted.
      singleBatch: true,
    });
    const batch = res?.cursor?.firstBatch ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
    after = batch[batch.length - 1]?._id;
    if (!after) break; // defensive: _id projected away despite the guard above
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
 * Aggregation, cursor drained FULLY, reply INSPECTED. Same truncation trap as
 * findAll(): a $group over a booking collection returns far more buckets than
 * one batch holds, and a reader that takes firstBatch reports a census of a
 * prefix. Unlike countWhere() this also surfaces command failure — $runCommandRaw
 * resolves rather than throwing, so an aggregate against a collection that does
 * not exist on this cluster would otherwise read as "zero rows", which is the
 * one answer a census must never invent.
 *
 * Returns { ok, errmsg, rows }. READ-ONLY: callers pass read pipelines only;
 * never give this a $merge or $out stage.
 */
export async function aggregateAll(db, collection, pipeline) {
  const raw = (cmd) => db.$runCommandRaw(cmd);
  const rows = [];

  // A pipeline is arbitrary, so this cannot be range-paged the way findAll is
  // (there may be no _id in the output at all). Instead ask for one large batch
  // so no getMore is needed at these data sizes, and treat any remaining cursor
  // as a READ FAILURE rather than paging into the same replica-set hazard.
  //
  // Why: $runCommandRaw carries no session and pins no connection, so a getMore
  // can be routed to a node that never had the cursor — Error 43
  // (CursorNotFound), thrown, mid-walk. See findAll above, where it fired on
  // the first real inventory run. A truncated census is the one answer this
  // helper must never invent, so if a batch ever does overflow, callers get
  // ok:false and surface "unreadable" instead of a confident prefix.
  const BATCH = 100000;
  let res;
  try {
    res = await raw({ aggregate: collection, pipeline, cursor: { batchSize: BATCH } });
  } catch (e) {
    return { ok: false, errmsg: `aggregate threw: ${String(e?.message ?? e)}`, rows };
  }
  if (numify(res?.ok) !== 1) {
    return { ok: false, errmsg: String(res?.errmsg ?? "(no errmsg)"), rows };
  }
  rows.push(...(res?.cursor?.firstBatch ?? []));

  const id = res?.cursor?.id;
  if (id && String(numify(id)) !== "0" && String(id) !== "0") {
    return {
      ok: false,
      errmsg:
        `result exceeded a single batch of ${BATCH} on "${collection}". Paging ` +
        `would need a getMore, which is unreliable here (see the note above). ` +
        `Narrow the pipeline or add a $limit, then re-run — do NOT treat the ` +
        `${rows.length} row(s) already read as the whole answer.`,
      rows,
    };
  }
  return { ok: true, errmsg: null, rows };
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
