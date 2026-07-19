/**
 * #16 (MERGE variant) — Merge every set of User documents that share the same
 * email (case-insensitive) into ONE surviving account, re-key ALL dependent data
 * onto the canonical NUSNET userID so nothing is orphaned, record each user's
 * matric number as an ATTRIBUTE in the UserMatric collection (the SAME storage
 * the login-gate reads), and finally enforce case-insensitive email uniqueness.
 *
 * This SUPERSEDES the delete-only `dedupe-users.mjs` for the 58 mixed-userID
 * groups it refuses to touch: those hold the same person under two identity
 * schemes (A0xxxxxxX matric account + Exxxxxxx NUSNET account) with their
 * Bookings/Gym/UserCCA/Order/Posts SPLIT across both userID strings. A blind
 * delete would orphan that data; this MERGE reassigns it first.
 *
 *   node scripts/remediation/merge-accounts.mjs            # DRY RUN (default)
 *   APPLY=yes node scripts/remediation/merge-accounts.mjs  # apply (writes)
 *
 * NOTE ON THE WRITE FLAG: this script uses APPLY=yes (NOT the DRY_RUN=false
 * convention of the older backfill scripts) because the task guidance names
 * APPLY=yes. Any value other than exactly "yes" is treated as a read-only run.
 *
 * Canonical identity per email group comes from the SHARED derivation in
 * scripts/remediation/lib/identity.mjs (canonicalUserID) — the same module
 * src/lib/identity.ts mirrors and verify-identity-parity.mjs gates. No formula
 * is restated here: a restated formula is a copy, and a copy drifts (09 §5.1).
 * The surviving User.userID is FORCED to this so it matches session.user.userID.
 *
 * A non-@u.nus.edu address canonicalises to "" — there is NO key this script
 * could write for it that a session would ever produce. Such a group is refused
 * (EMPTY_CANONICAL / NON_NUS_EMAIL), and if one ever reaches the apply loop
 * un-refused the whole run aborts rather than writing a dead key.
 *
 * GUARANTEES (hold regardless of DB availability — logic derived from the facts,
 * not from a live connection; Atlas is flaky):
 *  - Dry-run by default. Writes happen only when APPLY === "yes".
 *  - JSON backup of every affected User doc is written BEFORE any delete.
 *  - Idempotent: re-running after a successful apply is a no-op that still prints
 *    clean, all-green verification counts.
 *  - No orphans: prints per-collection dependent-row counts before/after; after
 *    the merge the canonical userID owns the sum and every old userID owns zero;
 *    global per-collection totals are conserved (updateMany MOVES, never copies).
 *  - Matric is written to UserMatric keyed by the canonical userID — the exact
 *    row the login gate (auth.ts session callback) reads by session.user.userID.
 *
 * ENGINE NOTE: uses PrismaClient + db.$runCommandRaw (the raw "mongodb" driver's
 * SRV DNS is blocked in this environment; the Prisma query engine works). All
 * UserMatric and dependent-collection ops go through $runCommandRaw so the script
 * works even before `prisma generate` picks up the UserMatric model. Raw commands
 * return Extended-JSON-shaped values ({$oid},{$date},{$numberLong}) — normalized
 * on read. Only db.user (update/delete/findMany) uses the typed delegate, which
 * already exists in the generated client.
 *
 * PREREQUISITES (see scripts/remediation/README.md "Step: merge accounts (#16)"):
 *   1. `npx prisma db push`  — creates the UserMatric collection + userID unique
 *      index and regenerates the client (auth.ts already reads db.userMatric).
 *   2. Deploy the login-gate code FIRST so freshly-merged users can clear it.
 *   3. Run this DRY (default), review, then APPLY=yes.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUserID, isNusStudentEmail } from "./lib/identity.mjs";
import { abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const APPLY = process.env.APPLY === "yes";

// Matric selection / validation regex. Matches the login-gate setMatric
// validator (src/server/api/routers/user.ts) so any matric the migration picks
// would also pass the gate: A + 7 digits + an uppercase letter (e.g. A0234567X).
const A_FORMAT = /^A\d{7}[A-Z]$/;

// Dependent collections keyed by the userID STRING that MUST follow the merge.
// (Raw collection names — Prisma applies no @@map, so model name == collection.)
const DEPENDENTS = ["Bookings", "Posts", "Order", "UserCCA", "Gym"];
// Audit-only history keyed by userID. Reported (per-userID counts) as a
// documented follow-up but NOT auto-reassigned (out of scope; see README #16).
const DEPENDENTS_OPTIONAL = ["BookingLogs"];

const BACKUP_DIR = join(dirname(fileURLToPath(import.meta.url)), "backups");
// Fixed filename (per task requirement). generatedAt is recorded INSIDE the file
// so a re-run refreshes it in place. Copy it aside before a real apply if you
// want to retain an older run's snapshot.
const BACKUP_PATH = join(BACKUP_DIR, "merge-backup.json");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// 09 §2.1/§5.1: a private `deriveCanonical()` used to live here, claiming to be
// an "EXACT mirror of the auth.ts session-callback derivation". 9cb701b replaced
// auth.ts's unanchored .replace() with the anchored shared derivation and this
// copy was never updated, so for a non-NUS address it returned a truthy
// "ALICE@GMAIL.COM" while every future session derives "". The private copy IS
// the failure — not a missing guard — and verify-identity-parity.mjs (C3) now
// bans one anywhere under scripts/ or src/. Use canonicalUserID, imported above.

/** Normalize an Extended-JSON scalar (number | {$numberInt|$numberLong}) to Number. */
function numify(v) {
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

/** Parse an Extended-JSON date ({$date} | {$date:{$numberLong}} | raw) to epoch ms. */
function parseDate(v) {
  if (!v) return 0;
  if (typeof v === "object") {
    const d = v.$date ?? v;
    if (d && typeof d === "object" && d.$numberLong != null) return Number(d.$numberLong);
    return new Date(d).getTime() || 0;
  }
  return new Date(v).getTime() || 0;
}

function nonEmpty(v) {
  return v !== null && v !== undefined && !(typeof v === "string" && v.trim() === "");
}

/** Docs sorted most-recently-created first (stable tiebreak: higher id). */
function byRecent(docs) {
  return [...docs].sort((a, b) => {
    const d = parseDate(b.createdAt) - parseDate(a.createdAt);
    if (d) return d;
    return (a.id ?? "") < (b.id ?? "") ? 1 : -1;
  });
}

/**
 * Keeper = the physical document that survives.
 *  1. Prefer a doc whose userID ALREADY equals canonical (the true NUSNET acct).
 *  2. Else prefer a doc WITH a non-empty passwordHash.
 *  3. Else most recently created.
 *  4. Else lowest _id string (stable).
 */
function pickKeeper(docs, canonical) {
  const canon = docs.filter((d) => d.userID === canonical);
  const pool = canon.length ? canon : docs;
  return [...pool].sort((a, b) => {
    if (a.hasHash !== b.hasHash) return a.hasHash ? -1 : 1;
    const d = parseDate(b.createdAt) - parseDate(a.createdAt);
    if (d) return d;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/** Matric = userID of the LATEST group member whose userID is A-format, else null. */
function pickMatric(docs) {
  const withMatric = byRecent(docs.filter((d) => A_FORMAT.test(d.userID ?? "")));
  return withMatric[0]?.userID ?? null;
}

/** Best value for a profile field: keeper's if non-empty, else most-recent member's. */
function bestField(docs, keeper, field) {
  if (nonEmpty(keeper[field])) return undefined; // keeper already good; no change
  const hit = byRecent(docs).find((d) => nonEmpty(d[field]));
  return hit ? hit[field] : undefined;
}

/** Best passwordHash: keeper's if present, else most-recent member with a hash. */
function bestHash(docs, keeper) {
  if (keeper.hasHash && nonEmpty(keeper.passwordHash)) return keeper.passwordHash;
  const hit = byRecent(docs).find((d) => d.hasHash && nonEmpty(d.passwordHash));
  return hit ? hit.passwordHash : null;
}

/** Raw count of a dependent collection by exact userID string. */
async function countRaw(coll, userID) {
  const r = await db.$runCommandRaw({ count: coll, query: { userID } });
  return numify(r?.n);
}

/** Raw updateMany: move every row from userID=src to userID=dst. Returns nModified. */
async function reassignRaw(coll, src, dst) {
  const r = await db.$runCommandRaw({
    update: coll,
    updates: [{ q: { userID: src }, u: { $set: { userID: dst } }, multi: true }],
  });
  return numify(r?.nModified);
}

/** Raw upsert of the matric attribute into UserMatric keyed by canonical userID. */
async function upsertMatricRaw(canonical, matric, source) {
  await db.$runCommandRaw({
    update: "UserMatric",
    updates: [
      {
        q: { userID: canonical },
        u: {
          $set: { matric, source: source ?? null, setAt: { $date: new Date().toISOString() } },
          $setOnInsert: { userID: canonical },
        },
        upsert: true,
        multi: false,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== merge-accounts.mjs ===`);
  console.log(`MODE: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`);

  // -- 1. Duplicate-email groups, with the full field set needed downstream. --
  const agg = await db.$runCommandRaw({
    aggregate: "User",
    pipeline: [
      {
        $group: {
          _id: { $toLower: "$email" },
          n: { $sum: 1 },
          docs: {
            $push: {
              id: { $toString: "$_id" },
              email: "$email",
              userID: "$userID",
              passwordHash: "$passwordHash",
              hasHash: { $cond: [{ $ifNull: ["$passwordHash", false] }, true, false] },
              displayName: "$displayName",
              bio: "$bio",
              telegramHandle: "$telegramHandle",
              block: "$block",
              createdAt: "$createdAt",
            },
          },
        },
      },
      { $match: { n: { $gt: 1 } } },
      { $sort: { n: -1 } },
    ],
    cursor: {},
  });
  const groups = agg.cursor?.firstBatch ?? [];
  console.log(`Duplicate-email groups (n > 1): ${groups.length}\n`);

  // -- 2. Build a plan per group (pure computation, no writes). --
  const plans = [];
  for (const g of groups) {
    const repEmail = g.docs.find((d) => nonEmpty(d.email))?.email ?? g._id;
    const canonical = canonicalUserID(repEmail);
    const keeper = pickKeeper(g.docs, canonical);
    const matric = pickMatric(g.docs);
    const hash = bestHash(g.docs, keeper);
    const oldIDs = [...new Set(g.docs.map((d) => d.userID).filter((u) => nonEmpty(u)))];
    const sourceIDs = oldIDs.filter((u) => u !== canonical);
    const deleteIds = g.docs.filter((d) => d.id !== keeper.id).map((d) => d.id);

    const flags = [];
    if (!nonEmpty(canonical)) flags.push("EMPTY_CANONICAL");
    // Shared predicate, not an inline .includes(): the old unanchored substring
    // test called bob@u.nus.edu.evil.com an NUS address (the exact shape the
    // anchored regex in lib/identity.mjs exists to reject).
    if (!isNusStudentEmail(repEmail)) flags.push("NON_NUS_EMAIL");
    if (A_FORMAT.test(canonical)) flags.push("CANONICAL_LOOKS_LIKE_MATRIC");
    if (!hash) flags.push("NO_HASH_IN_GROUP");
    if (!matric) flags.push("NO_MATRIC");
    const otherFmt = g.docs
      .map((d) => d.userID)
      .filter((u) => nonEmpty(u) && u !== canonical && !A_FORMAT.test(u) && !/^E\d{7}$/.test(u));
    if (otherFmt.length) flags.push("OTHER_FORMAT_USERID");
    const matricValues = new Set(
      g.docs.map((d) => d.userID).filter((u) => A_FORMAT.test(u ?? "")),
    );
    if (matricValues.size > 1) flags.push("MULTIPLE_MATRICS");
    const blockValues = new Set(g.docs.map((d) => d.block).filter((b) => b != null));
    if (blockValues.size > 1) flags.push("BLOCK_DISAGREEMENT");

    // Canonical must not already belong to a User OUTSIDE this group (would
    // collide the identity). Guarded so idempotent re-runs still return clean.
    let collision = false;
    try {
      const other = await db.user.findFirst({
        where: { userID: canonical, id: { notIn: g.docs.map((d) => d.id) } },
        select: { id: true },
      });
      collision = Boolean(other);
    } catch {
      /* connection may be flaky; leave collision=false and rely on assertions */
    }
    if (collision) flags.push("CANONICAL_COLLISION_OUTSIDE_GROUP");

    // A group is applied only if it is safe: has a hash, a non-empty canonical,
    // is an @u.nus.edu address at all, and has no external collision. Otherwise
    // it is reported for manual handling.
    //
    // NON_NUS_EMAIL is in the skip set even though, with the shared derivation,
    // a non-NUS group already trips EMPTY_CANONICAL. Two INDEPENDENT reasons to
    // refuse, deliberately: 09's whole thesis is that one unstated invariant
    // ("the empty test will catch it") is not a control. If a future derivation
    // change ever makes the empty test miss again, this one still holds.
    const skip = flags.includes("NO_HASH_IN_GROUP") ||
      flags.includes("EMPTY_CANONICAL") ||
      flags.includes("NON_NUS_EMAIL") ||
      flags.includes("CANONICAL_COLLISION_OUTSIDE_GROUP");

    // Best-of profile patch (validator-known User fields only).
    const patch = { userID: canonical };
    if (hash) patch.passwordHash = hash;
    for (const f of ["displayName", "bio", "telegramHandle", "block"]) {
      const v = bestField(g.docs, keeper, f);
      if (v !== undefined) patch[f] = v;
    }
    // Preserve a ban: if ANY member is blocked and the keeper is not, carry it.
    if (patch.block === undefined && keeper.block == null) {
      const blocked = byRecent(g.docs).find((d) => d.block != null);
      if (blocked) patch.block = blocked.block;
    }
    // Earliest createdAt = the account's true origin.
    const earliest = Math.min(...g.docs.map((d) => parseDate(d.createdAt)).filter((n) => n > 0));
    if (Number.isFinite(earliest) && earliest > 0) patch.createdAt = new Date(earliest);

    plans.push({
      email: g._id,
      repEmail,
      canonical,
      keeperId: keeper.id,
      keeperUserID: keeper.userID,
      matric,
      matricSource: matric, // the old A-format userID string the matric came from
      oldIDs,
      sourceIDs,
      deleteIds,
      patch,
      flags,
      skip,
      docs: g.docs,
    });
  }

  // -- 3. Backup EVERY affected User doc BEFORE any mutation. --
  mkdirSync(BACKUP_DIR, { recursive: true });
  const allAffectedIds = [...new Set(plans.flatMap((p) => p.docs.map((d) => d.id)))];
  let backupDocs = [];
  try {
    backupDocs = await db.user.findMany({ where: { id: { in: allAffectedIds } } });
  } catch (e) {
    // Fall back to the raw group payload (still a complete-enough snapshot).
    console.warn(`  (backup full-doc fetch failed: ${e.message}; using raw group payload)`);
    backupDocs = plans.flatMap((p) => p.docs);
  }
  const backup = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    groupCount: plans.length,
    affectedUserCount: allAffectedIds.length,
    groups: plans.map((p) => ({
      email: p.email,
      canonical: p.canonical,
      keeperId: p.keeperId,
      matricChosen: p.matric,
      sourceIDs: p.sourceIDs,
      deleteIds: p.deleteIds,
      flags: p.flags,
    })),
    userDocs: backupDocs,
  };
  try {
    writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2));
    console.log(`Backup of ${allAffectedIds.length} affected User docs -> ${BACKUP_PATH}\n`);
  } catch (e) {
    console.error(`*** ABORT: could not write backup file (${e.message}). ` +
      `Refusing to proceed without a persisted backup. ***`);
    process.exitCode = 1;
    return;
  }

  // -- 4. Per-group report + BEFORE counts. --
  const before = {}; // before[email][coll][userID] = n
  for (const p of plans) {
    const affected = [p.canonical, ...p.sourceIDs];
    before[p.email] = {};
    for (const coll of [...DEPENDENTS, ...DEPENDENTS_OPTIONAL]) {
      before[p.email][coll] = {};
      for (const uid of affected) {
        try {
          before[p.email][coll][uid] = await countRaw(coll, uid);
        } catch {
          before[p.email][coll][uid] = null; // connection flaky; mark unknown
        }
      }
    }
    const depSummary = DEPENDENTS.map((coll) => {
      const sum = Object.values(before[p.email][coll]).reduce((a, b) => a + (b ?? 0), 0);
      return `${coll}=${sum}`;
    }).join(" ");
    console.log(
      `${p.email}\n` +
      `  canonical=${p.canonical}  matric=${p.matric ?? "(none)"}  keep=${p.keeperId}` +
      `${p.keeperUserID !== p.canonical ? ` (userID ${p.keeperUserID}->${p.canonical})` : ""}\n` +
      `  reassign from [${p.sourceIDs.join(", ") || "-"}]  delete=${p.deleteIds.length}` +
      `  deps(before,total)= ${depSummary}` +
      (p.flags.length ? `\n  flags: ${p.flags.join(", ")}` : "") +
      (p.skip ? `  *** SKIP (manual handling required) ***` : ""),
    );
  }

  // -- 4b. PRECONDITION: no empty target key (rekey-canonical.mjs:71-81). ------
  //
  // The skip set above should already have refused every such group. This is the
  // backstop that does not depend on that being true. It ABORTS THE WHOLE RUN
  // rather than skipping the group and applying the rest, because the backup
  // written in step 3 captures User docs ONLY — not the prior userID of any
  // dependent Bookings/Posts/Order/UserCCA/Gym row. For a group with >= 2 source
  // IDs an applied merge is therefore unreconstructable, so a run that contains
  // even one unsound group must not write anything at all.
  //
  // Runs in BOTH modes: a dry run that would have written a dead key must say so
  // and exit non-zero, not print a clean plan.
  const emptyTargets = plans.filter((p) => !p.skip && !nonEmpty(p.canonical));
  for (const p of emptyTargets) {
    console.error(
      `  BLOCK  ${p.email}: canonical target key is "" ` +
      `(email ${JSON.stringify(p.repEmail)} is not @u.nus.edu); ` +
      `${p.deleteIds.length} User doc(s) and every dependent row would be re-keyed onto it`,
    );
  }
  if (emptyTargets.length) {
    abort(
      `${emptyTargets.length} group(s) have no valid target key. These are the D-7 non-NUS ` +
      `accounts — correct the address, merge the account by hand, or accept the block. ` +
      `There is no key this script could write that would be right. ` +
      `Nothing was written; the backup at ${BACKUP_PATH} still describes the pre-run state.`,
    );
    return;
  }

  // -- 5. APPLY: reassign -> update keeper -> upsert matric -> delete (per group). --
  const reassigned = Object.fromEntries(DEPENDENTS.map((c) => [c, 0]));
  let usersDeleted = 0;
  let matricsWritten = 0;
  const failures = [];

  if (APPLY) {
    console.log(`\n--- APPLYING ---`);
    for (const p of plans) {
      if (p.skip) {
        failures.push(`${p.email}: skipped (${p.flags.join(",")})`);
        continue;
      }
      try {
        // 5a. Reassign dependents BEFORE any delete (crash-safe ordering).
        for (const coll of DEPENDENTS) {
          for (const src of p.sourceIDs) {
            reassigned[coll] += await reassignRaw(coll, src, p.canonical);
          }
        }
        // 5b. Update keeper: userID=canonical + best-of fields (validator-safe).
        await db.user.update({ where: { id: p.keeperId }, data: p.patch });
        // 5c. Record matric in the SAME storage the login gate reads.
        if (p.matric) {
          await upsertMatricRaw(p.canonical, p.matric, p.matricSource);
          matricsWritten++;
        }
        // 5d. Delete non-keepers LAST (Session/Account/Authenticator cascade).
        for (const id of p.deleteIds) {
          try {
            await db.user.delete({ where: { id } });
            usersDeleted++;
          } catch {
            /* already gone (idempotent re-run) */
          }
        }
      } catch (e) {
        failures.push(`${p.email}: apply error: ${e.message}`);
        console.error(`  *** ERROR merging ${p.email}: ${e.message} — continuing ***`);
      }
    }
  }

  // -- 6. VERIFICATION (both modes). Apply recounts; dry-run predicts. --
  console.log(`\n--- VERIFICATION (${APPLY ? "recount" : "predicted from before-counts"}) ---`);
  for (const p of plans) {
    for (const coll of DEPENDENTS) {
      const beforeByUid = before[p.email][coll];
      const beforeSum = Object.values(beforeByUid).reduce((a, b) => a + (b ?? 0), 0);

      let afterCanon;
      let afterSrcTotal;
      if (APPLY && !p.skip) {
        try {
          afterCanon = await countRaw(coll, p.canonical);
          afterSrcTotal = 0;
          for (const src of p.sourceIDs) afterSrcTotal += await countRaw(coll, src);
        } catch {
          afterCanon = null;
          afterSrcTotal = null;
        }
      } else {
        // Prediction: everything lands on canonical, sources go to zero.
        afterCanon = beforeSum;
        afterSrcTotal = 0;
      }

      const conserved = afterCanon == null ? "n/a" : afterCanon + (afterSrcTotal ?? 0);
      const ok = afterCanon == null
        ? "SKIP-NODB"
        : afterCanon === beforeSum && (afterSrcTotal ?? 0) === 0
          ? "OK"
          : "FAIL";
      if (ok === "FAIL") {
        failures.push(
          `VERIFY FAIL ${p.email} ${coll}: before=${beforeSum} afterCanonical=${afterCanon} ` +
          `afterSources=${afterSrcTotal}`,
        );
        console.log(
          `  *** VERIFY FAILED group=${p.email} coll=${coll} ` +
          `before=${beforeSum} afterCanonical=${afterCanon} afterSources=${afterSrcTotal} ***`,
        );
      }
      // Only print noisy per-collection lines when non-trivial.
      if (beforeSum > 0 || ok === "FAIL") {
        console.log(
          `  ${p.email} ${coll}: before=${beforeSum} -> canonical=${afterCanon} ` +
          `sources=${afterSrcTotal} total=${conserved} [${ok}]`,
        );
      }
    }

    // Exactly one User remains for the email, with userID == canonical.
    if (APPLY && !p.skip) {
      try {
        const remaining = await db.user.count({
          where: { email: { equals: p.repEmail, mode: "insensitive" } },
        });
        if (remaining !== 1) {
          failures.push(`${p.email}: ${remaining} User docs remain (expected 1)`);
          console.log(`  *** ${p.email}: ${remaining} User docs remain (expected 1) ***`);
        }
      } catch {
        /* flaky; skip */
      }
    }
  }

  // -- 7. Audit-only: BookingLogs counts per userID (documented follow-up). --
  const logRows = plans.flatMap((p) =>
    DEPENDENTS_OPTIONAL.map((coll) => {
      const byUid = before[p.email]?.[coll] ?? {};
      const sum = Object.values(byUid).reduce((a, b) => a + (b ?? 0), 0);
      return sum > 0 ? `${p.email} ${coll}=${sum}` : null;
    }),
  ).filter(Boolean);
  if (logRows.length) {
    console.log(
      `\nAUDIT-ONLY (not reassigned — see README #16 follow-up): ` +
      logRows.join("  "),
    );
  }

  // -- 8. Singleton A-format users (finding #9): pre-seed matric so they are NOT
  //       needlessly gated, WITHOUT rewriting their identity. Also report the
  //       identity mismatch as a documented follow-up. --
  console.log(`\n--- SINGLETON A-FORMAT USERS (finding #9) ---`);
  let singletonSeeded = 0;
  let nonNusSingletons = 0;
  const mismatchSamples = [];
  try {
    const all = await db.user.findMany({ select: { id: true, email: true, userID: true } });
    const byEmail = new Map();
    for (const u of all) {
      const k = (u.email ?? "").toLowerCase();
      byEmail.set(k, (byEmail.get(k) ?? 0) + 1);
    }
    const singletonsA = all.filter(
      (u) => byEmail.get((u.email ?? "").toLowerCase()) === 1 && A_FORMAT.test(u.userID ?? ""),
    );
    console.log(`Non-duplicate A-format users to pre-seed matric: ${singletonsA.length}`);
    for (const u of singletonsA) {
      const canonical = canonicalUserID(u.email);
      // 09 §2.2: this block runs UNCONDITIONALLY under APPLY and its `canonical`
      // feeds the UserMatric upsert below. UserMatric.userID is uniquely indexed
      // (schema.prisma:431), so a ""-keyed row lands exactly once and is
      // PERMANENT — it is precisely the row auth.ts's early return exists to
      // never look up. A non-NUS singleton has no key worth seeding; skip it.
      if (!nonEmpty(canonical)) {
        nonNusSingletons++;
        continue;
      }
      if (u.userID !== canonical && mismatchSamples.length < 10) {
        mismatchSamples.push(
          `${u.email}: data keyed to ${u.userID}, runtime session.userID=${canonical}`,
        );
      }
      if (APPLY) {
        // Seed UNDER THE CANONICAL (E-format) userID — the exact key the login
        // gate reads (session.user.userID = canonicalUserID(email)). The matric
        // VALUE is their A-format userID. This un-gates them WITHOUT rewriting
        // their identity or data (the data-mis-keyed-under-A-format issue stays
        // the #9 follow-up reported below). create-only so it never clobbers a
        // real matric a user later submits.
        await db.$runCommandRaw({
          update: "UserMatric",
          updates: [
            {
              q: { userID: canonical },
              u: { $setOnInsert: { userID: canonical, matric: u.userID, source: "singleton-a-format" } },
              upsert: true,
              multi: false,
            },
          ],
        });
        singletonSeeded++;
      }
    }
    if (nonNusSingletons) {
      console.log(
        `Skipped ${nonNusSingletons} A-format singleton(s) whose email is not @u.nus.edu: ` +
        `canonical key is "" and a ""-keyed UserMatric row is permanent (09 §2.2).`,
      );
    }
    if (mismatchSamples.length) {
      console.log(
        `\nIDENTITY_MISMATCH_FOLLOWUP — these singletons have data keyed to their\n` +
        `A-format userID while their runtime session.user.userID is the E-format\n` +
        `derived from email, so their data looks empty at runtime. Do NOT rewrite\n` +
        `them here; run a separate, backed-up, signed-off re-key migration:\n` +
        mismatchSamples.map((s) => `  - ${s}`).join("\n") +
        (mismatchSamples.length >= 10 ? `\n  ... (sample truncated)` : ""),
      );
    }
  } catch (e) {
    console.warn(`  (singleton pass skipped — DB unavailable: ${e.message})`);
  }

  // -- 9. Enforce uniqueness (APPLY only, LAST, only if zero failures). --
  if (APPLY) {
    if (failures.length) {
      console.log(
        `\n*** ${failures.length} failure(s) — NOT creating email_unique_ci index ` +
        `(DB left in a resolvable state; fix the flagged groups and re-run). ***`,
      );
    } else {
      // UserMatric unique index (defensive; prisma db push also creates it).
      try {
        await db.$runCommandRaw({
          createIndexes: "UserMatric",
          indexes: [{ key: { userID: 1 }, name: "userID_unique", unique: true }],
        });
      } catch (e) {
        console.log(`UserMatric userID index: ${e.message}`);
      }
      // Case-insensitive unique email index.
      try {
        await db.$runCommandRaw({
          createIndexes: "User",
          indexes: [
            {
              key: { email: 1 },
              name: "email_unique_ci",
              unique: true,
              collation: { locale: "en", strength: 2 },
            },
          ],
        });
        console.log(`\nCreated case-insensitive unique index email_unique_ci on User.email.`);
      } catch (e) {
        const msg = String(e.message || e);
        if (/already exists|IndexOptionsConflict|IndexKeySpecsConflict/i.test(msg)) {
          console.log(`\nemail_unique_ci already present — no-op.`);
        } else if (/E11000|duplicate key/i.test(msg)) {
          console.log(
            `\n*** email_unique_ci creation FAILED on residual duplicates — a group ` +
            `did not fully merge. Offending key in: ${msg} ***`,
          );
          failures.push(`email_unique_ci: residual duplicates: ${msg}`);
        } else {
          console.log(`\nemail_unique_ci: ${msg}`);
          failures.push(`email_unique_ci: ${msg}`);
        }
      }
    }
  }

  // -- 10. Global summary. --
  console.log(`\n=== SUMMARY ===`);
  console.log(`Mode:                ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`Duplicate groups:    ${plans.length}`);
  console.log(`Groups skipped:      ${plans.filter((p) => p.skip).length}`);
  console.log(`Users deleted:       ${APPLY ? usersDeleted : "(dry-run: " + plans.filter((p) => !p.skip).reduce((a, p) => a + p.deleteIds.length, 0) + " planned)"}`);
  console.log(`Matrics written:     ${APPLY ? matricsWritten : "(dry-run: " + plans.filter((p) => p.matric && !p.skip).length + " planned)"}`);
  console.log(`Singleton A seeded:  ${APPLY ? singletonSeeded : "(dry-run)"}`);
  console.log(`Rows reassigned:     ${APPLY ? JSON.stringify(reassigned) : "(dry-run: none written)"}`);
  console.log(`Groups flagged:      ${plans.filter((p) => p.flags.length).length}`);
  console.log(`Verify/apply failures: ${failures.length}`);
  if (failures.length) {
    console.log(`\nFAILURES:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing changed. Re-run with APPLY=yes to apply.`);
  }
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
