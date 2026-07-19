/**
 * #16 (CANONICAL-IDENTITY variant) — Merge every set of User documents that
 * resolve to the SAME canonical NUSNET id into ONE surviving account, per-field.
 *
 *   node scripts/remediation/merge-by-canonical.mjs            # DRY RUN (default)
 *   node scripts/remediation/merge-by-canonical.mjs --commit   # apply (writes)
 *   APPLY=yes node scripts/remediation/merge-by-canonical.mjs  # same thing
 *
 * HOW THIS DIFFERS FROM merge-accounts.mjs (read that first — this script
 * follows its idiom, its ordering and its safety rails deliberately):
 *
 *  1. GROUPING KEY. merge-accounts groups by `$toLower: "$email"`. That is a
 *     STRING key, and a string key folds case but NOT whitespace: the live row
 *     `"e0425010@u.nus.edu "` sorts into its own group and stays a duplicate
 *     forever. This script groups by `canonicalUserID(email)` — the same
 *     derivation the session callback uses — so every address that a session
 *     would resolve to one identity lands in one group, whatever whitespace or
 *     case it carries. (The trailing-space row is a SINGLETON; it needs
 *     normalizing, not merging, and step 8 does exactly that.)
 *
 *  1b. GROUPING IS ALSO BY SHARED MATRIC, AND IT IS TRANSITIVE. Two rows are
 *     the same person if they share a canonical id OR a non-empty stored
 *     `User.userID`. The live data has three pairs that email-only grouping
 *     misses outright — E1355967 (lgd@ vs e1355967@), E1523366 (e153366@, a
 *     one-digit-short TYPO, vs e1523366@) and E1525917 (danvern@ vs
 *     e1525917@) — all of which are one human holding two accounts. Grouping
 *     is therefore connected-components (union-find) over both relations, so
 *     A~B by email and B~C by matric yield ONE group of three.
 *
 *     Consequence: a group can span SEVERAL canonical ids. One of them becomes
 *     the group's identity and the rest are LOSING KEYS whose dependent rows
 *     are reassigned onto it. See pickGroupCanonical() for the rule (E-format
 *     institutional id beats a name-style alias) and why.
 *
 *  2. PER-FIELD CONFLICT DETECTION. merge-accounts takes a best-of value and
 *     never notices disagreement. Here every mergeable field is classified:
 *     AGREE (all non-absent values equal under that field's normalizer) -> keep
 *     the normalized value; ABSENT-vs-PRESENT -> keep the present one, this is
 *     NOT a conflict; CONFLICT (two genuinely different values) -> CLEAR the
 *     field on the survivor and push its name onto ProfileCompletion.needsFields
 *     so the login gate re-collects it from the human, who is the only party
 *     that knows which value was right.
 *
 *  3. THE MATRIC CASE. Two different A-format matrics for one canonical id
 *     (E0201752 in the live data: A0172182Z vs A0172182J, one check digit apart
 *     — one of them is a typo and the DATA DOES NOT SAY WHICH). Picking either
 *     is a coin flip that silently assigns a real person the wrong student
 *     number. So: no UserMatric row is written, any existing one for that
 *     canonical id is REMOVED, and "matric" is flagged. The user re-keys it and
 *     the existing setMatric validator checks the format.
 *
 *  4. userCCA IS UNIONED, NEVER CLEARED. Two rows holding different CCA
 *     memberships are not contradicting each other — they are one person's
 *     memberships spread across two accounts. Clearing destroys real data that
 *     nothing else records, so the merged value is the deduplicated union and
 *     userCCA never appears in needsFields. Every other array field keeps the
 *     old rule (see the `modules` note in FIELDS for why they differ).
 *
 *  5. ONLY CONSEQUENTIAL FIELDS ARE PROMPTED FOR. Conflicting fields are all
 *     still CLEARED; `needsFields` — the list the login gate interrupts the
 *     user with — is filtered to PROMPTABLE (matric, telegramHandle,
 *     displayName, block). `bio` and the profile picture are cleared and NOT
 *     prompted: cosmetic, self-service, not worth a login interruption. A group
 *     whose only conflicts were cosmetic gets NO ProfileCompletion row at all
 *     rather than one with an empty needsFields.
 *
 * WHAT IS NEVER CLEARED, AND WHY. `userID` on the survivor is FORCED to the
 * canonical id and is not subject to conflict-clearing. It is not a profile
 * attribute, it is the OWNERSHIP KEY every dependent row is keyed on; clearing
 * it orphans the account's entire history and produces exactly the ""-keyed
 * identity C9 spent a whole remediation removing. The matric — a display
 * attribute living in UserMatric — is what gets withheld. Likewise
 * `passwordHash` is never cleared: two divergent hashes belong to the same
 * human, and clearing it locks that human out of the account they are supposed
 * to log into to FIX the flagged fields.
 *
 * GUARANTEES:
 *  - Dry run by default; writes only under --commit / APPLY=yes.
 *  - The FULL intended change set is printed before anything is written, in
 *    both modes.
 *  - A JSON backup of every affected User / UserRole / UserMatric /
 *    ProfileCompletion document AND every dependent-row count is written BEFORE
 *    the first write; the run aborts if that file cannot be written.
 *  - Dependent rows are reassigned onto the canonical id BEFORE any loser is
 *    deleted (merge-accounts' crash-safe ordering), and the ProfileCompletion
 *    flag is written BEFORE the delete too, so a crash leaves an over-flagged
 *    account rather than a silently-wrong one.
 *  - Idempotent / resumable: a re-run finds groups of size 1, matches 0 rows on
 *    every reassignment, sees the survivor already canonical, and re-upserts
 *    identical values. `resolvedAt` is NEVER written, so a re-run cannot
 *    un-resolve a prompt the user already answered.
 *  - VERIFY pass in both modes; it NAMES every offender (I-16) and sets a
 *    non-zero exit code.
 *  - $runCommandRaw does NOT throw on a write failure — every reply goes
 *    through inspectWriteReply() and writeErrors are treated as failures. This
 *    matters more here than anywhere else in this directory: `User` is
 *    validator-guarded, so a clear that the $jsonSchema rejects comes back as
 *    writeErrors[0].code 121 with ok:1, and an uninspected reply would report a
 *    successful merge over a document that never changed.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUserID, isNusStudentEmail, normalizeEmail } from "./lib/identity.mjs";
import {
  findAll, numify, inspectWriteReply, isCommit, banner, abort, fileStamp, nowExt,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

/**
 * Opt-in for groups that span more than one canonical id. Held back by default
 * because deleting the losing row also deletes a WORKING LOGIN — see the
 * skipReason at the plan site. Review those by hand; this flag exists so the
 * decision is explicit rather than a code edit.
 */
const INCLUDE_CROSS_CANONICAL = process.argv.includes("--include-cross-canonical");
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

/** Matches the setMatric validator in src/server/api/routers/user.ts. */
const A_FORMAT = /^A\d{7}[A-Z]$/;

/**
 * A WELL-FORMED institutional NUSNET id: "E" + exactly seven digits. Used ONLY
 * to rank two canonical ids against each other in pickGroupCanonical(). It is
 * NEVER an eligibility test — L-27 (`g.s_samuel@u.nus.edu` -> "G.S_SAMUEL") is
 * a real account and must keep working, which is why a group whose canonicals
 * are all name-style still merges, it just ranks them lexicographically.
 */
const E_FORMAT = /^E\d{7}$/;

/**
 * CHANGE 3 — the ONLY field names that may reach ProfileCompletion.needsFields.
 *
 * Conflicting fields are still CLEARED exactly as before; this list decides
 * only what the login gate INTERRUPTS the user to re-collect. The bar is
 * "wrong/absent value has a consequence someone else feels": a wrong matric
 * mis-identifies the human, a wrong telegramHandle messages a stranger, a wrong
 * displayName mis-labels them to the hall, a wrong block decides which
 * facilities they may book.
 *
 * DELIBERATELY ABSENT: "bio" and "profilePicture" (the imageKey clear). Both
 * are cosmetic and self-service — the owner's ruling: "its non essential so they
 * can edit the profile and add it later on too". They are still cleared, just
 * not prompted for. "modules" is likewise absent: it is self-service and
 * re-derivable each semester, and it is not on the owner's include list.
 *
 * If filtering leaves a group with NO promptable fields, NO ProfileCompletion
 * row is written at all (step 6d already guards on needsFields.length) — an
 * empty flag is a login interruption with nothing to ask for.
 */
const PROMPTABLE = new Set(["matric", "telegramHandle", "displayName", "block"]);

/**
 * SURVIVOR CANONICAL SELECTION (new in CHANGE 1).
 *
 * A group may now span SEVERAL canonical ids, because two rows also group when
 * they share a stored matric. One of those canonicals becomes the group's
 * identity — the key every dependent row is moved onto — and the rest become
 * LOSING KEYS whose rows are reassigned to it.
 *
 * THE RULE, in order:
 *   1. A well-formed E-format canonical (/^E\d{7}$/) beats a name-style one.
 *   2. Otherwise, lowest lexicographically (total, deterministic, re-run stable).
 *
 * WHY RULE 1. The E-format address is the INSTITUTIONAL one — it is issued with
 * the matric, it is what the university will still resolve after graduation, and
 * it is the address every other NUS system keys on. A name-style localpart
 * (`lgd@`, `danvern@`) is a self-chosen ALIAS pointing at the same mailbox.
 * Merging onto the alias would key the account on something the institution does
 * not consider primary and that the user may re-point.
 *
 * Rule 1 also happens to resolve the nastiest live case correctly WITHOUT
 * special-casing it: `e153366@u.nus.edu` is a one-digit-short typo of
 * `e1523366@u.nus.edu`, so its canonical "E153366" (six digits) FAILS E_FORMAT
 * while the real "E1523366" passes, and the typo becomes the losing key. That is
 * a consequence of the rule, not a patch for the row — but it is exactly why the
 * rule tests the SHAPE rather than merely preferring anything starting with "E".
 *
 * NOTE this is independent of pickSurvivor(), which chooses which _id survives.
 * The surviving ROW need not be one whose own email produced the surviving
 * CANONICAL; its userID is forced to the group canonical either way.
 */
function pickGroupCanonical(canonicals) {
  return [...canonicals].sort((a, b) => {
    const ea = E_FORMAT.test(a) ? 0 : 1;
    const eb = E_FORMAT.test(b) ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return a < b ? -1 : 1;
  })[0];
}

/**
 * CHANGE 1 — TRANSITIVE grouping (union-find / connected components).
 *
 * Two User rows are the same person if they share a canonical id (the original
 * rule) OR a non-empty stored `User.userID` (the matric). Transitivity is not
 * optional: A~B by email and B~C by matric must put all three in ONE group, and
 * a pairwise or single-pass grouping would emit A+B and a separate C, then merge
 * them onto keys that still collide. Union-find is the only shape that gets that
 * right regardless of iteration order.
 *
 * Nodes are namespaced strings ("doc:<id>", "canon:<C>", "matric:<M>") so a
 * canonical id and an identically-spelled stored matric — which is the common
 * case, not an edge case — cannot alias each other.
 */
function makeUnionFind() {
  const parent = new Map();
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); return x; };
  const find = (x) => {
    add(x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

/**
 * Dependent collections keyed by the userID STRING with NO uniqueness
 * constraint on it — a plain updateMany moves them safely.
 */
const DEPENDENTS = ["Bookings", "Posts", "Order", "UserCCA", "Gym"];
/** Counted, reported, NOT reassigned — same out-of-scope call as merge-accounts. */
const DEPENDENTS_OPTIONAL = ["BookingLogs"];
/**
 * Keyed by userID and UNIQUE on it. These can NOT go through the updateMany
 * path: moving a loser's row onto a canonical id that already has one is a
 * duplicate-key write error, which $runCommandRaw reports as writeErrors rather
 * than throwing — i.e. it would look like a clean run and leave the loser's row
 * behind under a dead key. They are merged by value instead (steps 5b/5c).
 */
const SINGLETON_KEYED = ["UserRole", "UserMatric"];

// ---------------------------------------------------------------------------
// FIELD CLASSIFICATION — the whole judgement of this script, in one table.
// ---------------------------------------------------------------------------
//
// `norm`  : maps a stored value to the form two rows are COMPARED in. Two rows
//           whose normalized values are equal DO NOT CONFLICT. This is where
//           "whitespace-only differences are not conflicts" is implemented.
// `absent`: true when the value carries no information. An absent value never
//           conflicts with anything — it loses to any present value. This is
//           the difference between "we disagree" and "only one of us answered",
//           and conflating them is what would have needlessly cleared
//           `modules` for the live E0201752 pair ([] vs ["HY2262","PR2202"]).
// `clear` : the value written on conflict. ALWAYS a typed empty ("" or []),
//           NEVER null and NEVER $unset. The `User` collection's $jsonSchema
//           may declare a field `required` and/or `bsonType: "string"`; "" is
//           accepted by both, whereas $unset violates `required` and null
//           violates `bsonType`. Choosing the empty value keeps the clear
//           inside whatever the validator already permits.
// `flag`  : the ProfileCompletion.needsFields name the user is re-prompted for.
//
const FIELDS = [
  {
    name: "displayName",
    // Trim + collapse internal runs of whitespace, compare case-insensitively.
    // "Joey  Tay" / "joey tay" / " Joey Tay" are one name typed three ways, not
    // three people; clearing a name over capitalisation would be absurd.
    // The SURVIVOR's spelling (trimmed, collapsed) is what is kept.
    norm: (v) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase(),
    keep: (v) => String(v ?? "").trim().replace(/\s+/g, " "),
    absent: (v) => !String(v ?? "").trim(),
    clear: "",
    flag: "displayName",
  },
  {
    name: "bio",
    // Trim ONLY — the live pair is " hello" vs "hello", the exact
    // whitespace-only difference the brief calls out as a non-conflict.
    // Interior text and case are CONTENT here, so they are compared verbatim:
    // two genuinely different bios are a real disagreement.
    norm: (v) => String(v ?? "").trim(),
    keep: (v) => String(v ?? "").trim(),
    absent: (v) => !String(v ?? "").trim(),
    clear: "",
    flag: "bio",
  },
  {
    name: "telegramHandle",
    // Trim, drop a leading "@", lowercase: Telegram usernames are
    // case-insensitive and users type the "@" inconsistently, so "@JoeyTay_"
    // and "joeytay_" are the same handle. "joeytay_" vs "joey_tay" (the live
    // pair) survives all of that normalization and IS a genuine conflict — two
    // different accounts, and messaging the wrong one is a real consequence.
    norm: (v) => String(v ?? "").trim().replace(/^@+/, "").toLowerCase(),
    keep: (v) => String(v ?? "").trim().replace(/^@+/, ""),
    absent: (v) => !String(v ?? "").trim().replace(/^@+/, ""),
    clear: "",
    flag: "telegramHandle",
  },
  {
    name: "block",
    // Integer hall block. Exact equality; null/absent is "not recorded", not
    // "block 0". Two different non-null blocks are a conflict — it decides
    // which residents' facilities they can book.
    norm: (v) => (v == null ? null : String(numify(v))),
    keep: (v) => numify(v),
    absent: (v) => v == null,
    clear: null, // handled specially: block is an Int?, so its empty IS null
    flag: "block",
  },
  {
    name: "modules",
    // String list. [] is ABSENT (nobody typed anything), so [] vs
    // ["HY2262","PR2202"] keeps the latter and raises NO flag. Two different
    // non-empty sets conflict — a union would silently enrol someone in modules
    // they dropped. Order-insensitive and de-duplicated, since list order here
    // carries no meaning.
    norm: (v) => JSON.stringify([...new Set((Array.isArray(v) ? v : []).map(String))].sort()),
    keep: (v) => [...new Set((Array.isArray(v) ? v : []).map(String))],
    absent: (v) => !Array.isArray(v) || v.length === 0,
    clear: [],
    flag: "modules",
  },
  {
    name: "userCCA",
    // CHANGE 2 — userCCA IS NEVER CLEARED. IT IS UNIONED.
    //
    // Same SHAPE as modules, opposite RULE, and the difference is what the two
    // fields mean. `modules` is a snapshot of one semester's enrolment: a union
    // would re-enrol someone in a module they dropped, so disagreement there is
    // a genuine contradiction and gets cleared. `userCCA` is a membership LIST,
    // and two rows carrying different memberships are not contradicting each
    // other — they are two accounts of ONE person, each holding the CCAs that
    // person joined while signed into that account. The union is the true
    // answer, and clearing it would destroy real data that nothing else in the
    // system records.
    //
    // Consequence: userCCA can never reach "conflict" status, is never CLEARed,
    // and carries NO flag — it must not appear in ProfileCompletion.needsFields,
    // because there is nothing for the user to re-enter.
    union: true,
    norm: (v) => JSON.stringify([...new Set((Array.isArray(v) ? v : []).map((x) => numify(x)))].sort((a, b) => a - b)),
    keep: (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => numify(x)))],
    absent: (v) => !Array.isArray(v) || v.length === 0,
    clear: [],
    flag: null, // never prompted — see above
  },
  {
    name: "imageKey",
    // Object-storage path for the profile picture. Compared VERBATIM after a
    // trim. In the live data the two values differ only because each is
    // prefixed with its row's (conflicting) matric —
    // "A0172182Z/profile_pic.png" vs "A0172182J/profile_pic.png" — and it is
    // tempting to call that a derived conflict and strip the prefix. Do not:
    // they are two DISTINCT objects in the bucket holding two different
    // uploads, and whichever matric turns out to be the typo, its object is the
    // one that will 404. Clearing costs the user one re-upload; guessing leaves
    // a broken avatar nobody can explain.
    norm: (v) => String(v ?? "").trim(),
    keep: (v) => String(v ?? "").trim(),
    absent: (v) => !String(v ?? "").trim(),
    clear: "",
    flag: "profilePicture",
  },
];

/**
 * NOT in FIELDS, each for a stated reason:
 *   userID        — the ownership key, forced to canonical (see header).
 *   passwordHash  — never cleared (see header); resolved by bestHash().
 *   email         — the grouping key by construction; every member normalizes
 *                   to the same canonical id, so members can differ only in
 *                   case/whitespace. Not a conflict: the survivor gets
 *                   normalizeEmail() of its own address.
 *   createdAt     — never a conflict; the EARLIEST value is the account's true
 *                   origin, same rule as merge-accounts.
 *   _id           — decided by survivor selection.
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

/** Docs most-recently-created first; stable tiebreak on _id. Same as merge-accounts. */
function byRecent(docs) {
  return [...docs].sort((a, b) => {
    const d = parseDate(b.createdAt) - parseDate(a.createdAt);
    if (d) return d;
    return (a.id ?? "") < (b.id ?? "") ? 1 : -1;
  });
}

/** How many mergeable fields this row actually answers. */
function completeness(doc) {
  return FIELDS.filter((f) => !f.absent(doc[f.name])).length;
}

/**
 * SURVIVOR SELECTION — deterministic, total, and in this order:
 *
 *   1. userID already === canonical. Such a row IS the NUSNET-scheme account;
 *      keeping it means step 5b rewrites no key at all and its Sessions stay
 *      coherent with the identity the app derives.
 *   2. has a passwordHash. Deleting the row that holds the only credential in
 *      the group would lock the user out of the account they must log into to
 *      answer the ProfileCompletion prompt. (bestHash() also copies a hash onto
 *      a hash-less survivor, so this is belt AND braces.)
 *   3. MOST COMPLETE (most non-absent mergeable fields), descending.
 *   4. most recently created.
 *   5. lowest _id.
 *
 * WHY COMPLETENESS BEFORE RECENCY, which is where this departs from
 * merge-accounts. The two live rows for E0201752 were created MINUTES apart on
 * the same day (604f0576…, 604f0851…), so "most recent" is not a signal about
 * which account the human actually used — it is a coin flip dressed as a rule.
 * Field count is a signal: the row carrying modules, CCAs and a filled bio is
 * the one that was lived in. It also minimises the number of $set operations
 * the merge has to perform against the validator-guarded User document, and
 * every avoided write is an avoided way to be rejected.
 *
 * Note the survivor choice CANNOT change the merged outcome for any field:
 * conflict detection runs over the whole group and is survivor-independent.
 * What it decides is which _id — and therefore which Session/Account/
 * Authenticator rows, which cascade-delete with the loser — survives.
 */
function pickSurvivor(docs, canonical) {
  const canon = docs.filter((d) => d.userID === canonical);
  const pool = canon.length ? canon : docs;
  return [...pool].sort((a, b) => {
    if (a.hasHash !== b.hasHash) return a.hasHash ? -1 : 1;
    const c = completeness(b) - completeness(a);
    if (c) return c;
    const d = parseDate(b.createdAt) - parseDate(a.createdAt);
    if (d) return d;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/** Survivor's hash if it has one, else the most recent member's. Never cleared. */
function bestHash(docs, survivor) {
  if (survivor.hasHash && nonEmpty(survivor.passwordHash)) return survivor.passwordHash;
  const hit = byRecent(docs).find((d) => d.hasHash && nonEmpty(d.passwordHash));
  return hit ? hit.passwordHash : null;
}

/**
 * Classify one field across a group.
 * Returns { status: "absent"|"agree"|"union"|"conflict", value, distinct }.
 *
 * "union" is reachable only for a field declaring `union: true` (userCCA), and
 * only where a non-union field would have said "conflict". It is NOT a conflict:
 * nothing is cleared and nothing is flagged.
 */
function classify(docs, field) {
  const present = docs.filter((d) => !field.absent(d[field.name]));
  if (!present.length) return { status: "absent", value: undefined, distinct: [] };
  const buckets = new Map();
  for (const d of present) {
    const k = field.norm(d[field.name]);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(d);
  }
  if (buckets.size === 1) {
    // All present rows agree under this field's normalizer. Keep the value in
    // its NORMALIZED-FOR-STORAGE form (trimmed etc.) — this is what turns
    // " hello" into "hello" instead of preserving a stray space forever.
    const rep = byRecent(present)[0];
    return { status: "agree", value: field.keep(rep[field.name]), distinct: [...buckets.keys()] };
  }
  if (field.union) {
    // Deduplicated union across every present row, in the field's own kept form.
    // Numeric ids sort numerically so the stored order is stable across re-runs
    // (idempotence: a second pass must produce a byte-identical array).
    const merged = [...new Set(present.flatMap((d) => field.keep(d[field.name])))]
      .sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : 1));
    return { status: "union", value: merged, distinct: [...buckets.keys()] };
  }
  return { status: "conflict", value: field.clear, distinct: [...buckets.keys()] };
}

/** Count rows in a dependent collection by exact userID (aggregation, not `count`). */
async function countKeyed(coll, userID) {
  const r = await raw({
    aggregate: coll,
    pipeline: [{ $match: { userID } }, { $count: "n" }],
    cursor: {},
  });
  return numify(r?.cursor?.firstBatch?.[0]?.n);
}

async function docsKeyed(coll, userID) {
  const r = await raw({ find: coll, filter: { userID }, limit: 1000, singleBatch: true });
  return r?.cursor?.firstBatch ?? [];
}

/** updateMany src -> dst on a non-unique userID key. Reply INSPECTED. */
async function reassignRaw(coll, src, dst, failures, label) {
  const reply = await raw({
    update: coll,
    updates: [{ q: { userID: src }, u: { $set: { userID: dst } }, multi: true }],
  });
  const r = inspectWriteReply(reply, `${label} ${coll} ${src}->${dst}`);
  if (!r.ok || r.writeErrors.length || r.writeConcernError.length) {
    failures.push(
      `${label}: ${coll} reassign ${src} -> ${dst} FAILED: ` +
      JSON.stringify(r.writeErrors.concat(r.writeConcernError)),
    );
    return 0;
  }
  return r.nModified;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  banner("merge-by-canonical.mjs", COMMIT);
  const failures = [];

  // -- 0. Show the User validator, since every clear must survive it. --------
  //
  // Read-only. Printed rather than enforced: the script cannot know which
  // clears a given $jsonSchema will accept, so it prints what the operator is
  // up against and then relies on inspectWriteReply to catch an actual
  // rejection (code 121) instead of pretending it succeeded.
  try {
    const lc = await raw({ listCollections: 1, filter: { name: "User" } });
    const v = lc?.cursor?.firstBatch?.[0]?.options?.validator;
    if (v) {
      const req = v.$jsonSchema?.required;
      console.log(`User $jsonSchema present. required = ${JSON.stringify(req ?? "(none)")}`);
      console.log(`  (a clear writes "" or [], never null and never $unset — see FIELDS)\n`);
    } else {
      console.log(`User has no $jsonSchema validator on this cluster.\n`);
    }
  } catch (e) {
    console.log(`(could not read the User validator: ${e.message})\n`);
  }

  // -- 1. Load every User and group by CANONICAL id (not by email string). ---
  const users = await findAll(db, "User");
  console.log(`User rows read: ${users.length}`);

  const eligible = [];   // docs that HAVE a canonical id
  const ineligible = []; // rows with no canonical id at all
  for (const u of users) {
    const email = typeof u.email === "string" ? u.email : "";
    const canonical = canonicalUserID(email);
    const doc = {
      id: String(u._id?.$oid ?? u._id ?? ""),
      _raw: u,
      email,
      normalizedEmail: normalizeEmail(email),
      userID: typeof u.userID === "string" ? u.userID : null,
      passwordHash: u.passwordHash ?? null,
      hasHash: nonEmpty(u.passwordHash),
      createdAt: u.createdAt,
    };
    for (const f of FIELDS) doc[f.name] = u[f.name];

    if (!canonical) {
      // C9: absent is null. The falsy test blocks null, "" and undefined alike,
      // so this gate stays armed however absence is spelled next.
      ineligible.push({ ...doc, reason: isNusStudentEmail(email) ? "NO_CANONICAL" : "NON_NUS_EMAIL" });
      continue;
    }
    doc.canonical = canonical;
    eligible.push(doc);
  }

  // -- 1b. CONNECTED COMPONENTS over {shared canonical} U {shared matric}. ----
  //
  // A row with NO canonical id is NOT admitted here even if its stored userID
  // matches a group's. It has no identity this script could merge it onto, the
  // whole point of the canonical grouping is that the key must be one a SESSION
  // would derive, and pulling such a row in would make it a loser and DELETE it.
  // They stay named in the UNCANONICAL list above and are left alone.
  const uf = makeUnionFind();
  for (const d of eligible) {
    uf.union(`doc:${d.id}`, `canon:${d.canonical}`);
    // The stored matric edge. Namespaced separately from `canon:` so that the
    // extremely common `userID === own canonical` case adds a harmless second
    // edge to the same component rather than aliasing two different key spaces.
    if (nonEmpty(d.userID)) uf.union(`doc:${d.id}`, `matric:${d.userID}`);
  }

  const components = new Map(); // root -> docs[]
  for (const d of eligible) {
    const root = uf.find(`doc:${d.id}`);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(d);
  }

  const groups = [];
  for (const docs of components.values()) {
    const canonicals = [...new Set(docs.map((d) => d.canonical))].sort();
    const canonical = pickGroupCanonical(canonicals);
    groups.push({
      canonical,
      canonicals,
      // Every OTHER canonical in the component. These are real keys that
      // dependent rows may be filed under, so they join sourceIDs below.
      losingCanonicals: canonicals.filter((c) => c !== canonical),
      docs,
    });
  }

  const multi = groups.filter((g) => g.docs.length > 1);
  const singles = groups.filter((g) => g.docs.length === 1);
  const distinctCanonicals = new Set(eligible.map((d) => d.canonical));
  console.log(`Canonical identities:        ${distinctCanonicals.size}`);
  console.log(`Identity groups (canonical OR shared matric, transitive): ${groups.length}`);
  console.log(`  with >1 User row (MERGE):  ${multi.length}`);
  console.log(`    of which span >1 canonical id: ${multi.filter((g) => g.canonicals.length > 1).length}`);
  console.log(`  singletons:                ${singles.length}`);
  console.log(`Rows with NO canonical id:   ${ineligible.length}`);
  for (const r of ineligible) {
    // I-16: name them. These are never merged and never re-keyed.
    console.log(`  UNCANONICAL  _id=${r.id} email=${JSON.stringify(r.email)} (${r.reason})`);
  }
  console.log("");

  // -- 2. Build a plan per multi-row group (pure computation, no writes). ----
  let plans = [];
  for (const { canonical, canonicals, losingCanonicals, docs } of multi) {
    const survivor = pickSurvivor(docs, canonical);
    const losers = docs.filter((d) => d.id !== survivor.id);

    const fieldPlan = [];
    const needsFields = [];
    const conflictNames = [];
    for (const f of FIELDS) {
      const c = classify(docs, f);
      fieldPlan.push({ field: f.name, ...c });
      if (c.status === "conflict") {
        // The field is CLEARED regardless — conflictNames drives the audit
        // reason string. Only PROMPTABLE names reach needsFields (CHANGE 3).
        conflictNames.push(f.name);
        if (f.flag && PROMPTABLE.has(f.flag) && !needsFields.includes(f.flag)) {
          needsFields.push(f.flag);
        }
      }
    }

    // --- the matric, which lives in UserMatric, not on User -----------------
    // Candidates: every A-format userID in the group, plus any matric already
    // recorded under any of the group's keys (collected live in step 3).
    const matricCandidates = [
      ...new Set(docs.map((d) => d.userID).filter((u) => A_FORMAT.test(u ?? ""))),
    ];
    const matricConflict = matricCandidates.length > 1;
    if (matricConflict && !needsFields.includes("matric")) {
      needsFields.push("matric");
      conflictNames.push("userID(matric)");
    }

    // Every distinct non-canonical key whose dependent rows must move. Two
    // sources now, not one:
    //   - stored userIDs on the group's rows (the original set), and
    //   - CHANGE 1: every LOSING canonical id in the group. A group can now span
    //     several canonicals, and dependent rows may already be filed under any
    //     of them (rekey-canonical and the session callback both write the
    //     canonical, not the stored matric). Omitting them would leave live rows
    //     stranded under a key whose only User row is about to be deleted.
    const oldIDs = [...new Set([
      ...docs.map((d) => d.userID).filter((u) => nonEmpty(u)),
      ...losingCanonicals,
    ])];
    const sourceIDs = oldIDs.filter((u) => u !== canonical);

    const hash = bestHash(docs, survivor);
    const earliest = Math.min(
      ...docs.map((d) => parseDate(d.createdAt)).filter((n) => n > 0),
    );

    // --- the $set applied to the survivor ----------------------------------
    const set = { userID: canonical, email: survivor.normalizedEmail };
    if (hash) set.passwordHash = hash;
    for (const fp of fieldPlan) {
      if (fp.status === "absent") continue; // leave the document as it is
      const f = FIELDS.find((x) => x.name === fp.field);
      if (fp.status === "conflict" && f.name === "block") {
        // block is an Int?; its typed empty IS null, and Prisma/the validator
        // already accept a missing block (the model is `block Int?`). This is
        // the single field whose clear is not "" or [].
        set.block = null;
      } else {
        set[fp.field] = fp.value;
      }
    }
    if (Number.isFinite(earliest) && earliest > 0) {
      set.createdAt = { $date: new Date(earliest).toISOString() };
    }

    const flags = [];
    if (!hash) flags.push("NO_HASH_IN_GROUP");
    if (matricConflict) flags.push("MULTIPLE_MATRICS");
    if (docs.filter((d) => d.hasHash).length > 1) {
      const hashes = new Set(docs.filter((d) => d.hasHash).map((d) => String(d.passwordHash)));
      if (hashes.size > 1) flags.push("PASSWORD_HASH_DIVERGENCE");
    }
    if (A_FORMAT.test(canonical)) flags.push("CANONICAL_LOOKS_LIKE_MATRIC");
    // In a multi-canonical group the surviving ROW is chosen by completeness,
    // which need not be the row whose email produced the surviving CANONICAL.
    // Its userID is forced to the group canonical either way, so the merge is
    // correct — but the survivor's stored email then no longer canonicalises to
    // its own userID. That is DELIBERATE and is NOT repaired here: rewriting a
    // person's email address is an auth-affecting change (lgd@ and danvern@ are
    // live aliases people actually sign in with), and it is out of scope for a
    // merge. Named so an operator can decide per row — E153366 in particular is
    // a typo'd address that may not receive mail.
    if (survivor.canonical !== canonical) {
      flags.push(`SURVIVOR_EMAIL_CANON_${survivor.canonical}_NOT_${canonical}`);
    }

    plans.push({
      canonical,
      canonicals,
      losingCanonicals,
      docs,
      survivor,
      losers,
      fieldPlan,
      needsFields,
      conflictNames,
      matricCandidates,
      matricConflict,
      sourceIDs,
      set,
      flags,
      // NO_HASH_IN_GROUP is reported but does NOT skip: unlike merge-accounts
      // (which had to write a matric for the login gate to be clearable), the
      // merge itself is still correct for a hash-less pair, and leaving two
      // rows under one canonical id is the very defect being removed.
      //
      // A CROSS-CANONICAL group DOES skip, unless --include-cross-canonical.
      //
      // Sign-in looks the User row up BY EMAIL, and the session derives the
      // identity key from that same email. When a group spans one canonical id,
      // every row carries the same address, so whichever row survives the person
      // still signs in and still lands on their data. When it spans TWO, the
      // losing row's address is deleted — and that address is a working login:
      //
      //   E1523366: KEEP e153366@u.nus.edu (a one-digit typo, more complete)
      //             DELETE e1523366@u.nus.edu (the real address)
      //     -> signing in with the real address finds no row at all
      //     -> signing in with the typo yields key E153366, while the data was
      //        just moved to E1523366, so the account looks empty
      //
      //   LGD / DANVERN: the losing address is a live alias people actually use.
      //
      // Either way the merge is data-correct and login-broken, and no survivor
      // rule fixes it alone — the second address has to survive as a login, or
      // a human has to choose. Three accounts are not worth blocking the other
      // 56, so they are held out by default and reported for review.
      skip: canonicals.length > 1 && !INCLUDE_CROSS_CANONICAL,
      skipReason:
        canonicals.length > 1 && !INCLUDE_CROSS_CANONICAL
          ? `spans ${canonicals.length} canonical ids [${canonicals.join(", ")}] — deleting the losing row removes a working login. Review by hand, or re-run with --include-cross-canonical.`
          : null,
    });
  }

  // -- 2a-bis. HOLD the skipped groups out of everything downstream. --------
  //
  // Removed from `plans` entirely rather than filtered at each write site: a
  // held group must not reach the precondition gates, the backup, the flag
  // writer or the verifier, and "remember to check p.skip" at six call sites is
  // the kind of invariant that survives exactly one refactor.
  const held = plans.filter((p) => p.skip);
  plans = plans.filter((p) => !p.skip);

  if (held.length) {
    console.log(`\n--- HELD BACK (${held.length} group(s), NOT merged) ---`);
    for (const p of held) {
      console.log(`\n  ! canonical ${p.canonical}   (${p.docs.length} rows)`);
      console.log(`      ${p.skipReason}`);
      for (const d of p.docs) {
        console.log(
          `      _id=${d.id} canon=${d.canonical} email=${JSON.stringify(d.email)} ` +
            `userID=${JSON.stringify(d.userID ?? null)} ` +
            `name=${JSON.stringify(d._raw?.displayName ?? null)}`,
        );
      }
    }
    console.log(
      `\n  These are UNTOUCHED — no field cleared, no row deleted, no dependent\n` +
        `  reassigned. Every other group proceeds normally.\n`,
    );
  }

  // -- 2b. PRECONDITION: no empty target key. --------------------------------
  //
  // Structurally impossible here (a null canonical never enters `groups` at
  // all), and kept anyway for exactly the reason merge-accounts keeps its copy:
  // "the grouping already excludes it" is an unstated invariant, not a control,
  // and this gate must not depend on a future refactor preserving it. Falsy
  // test, so null/""/undefined are all blocked. Runs in BOTH modes.
  const emptyTargets = plans.filter((p) => !p.canonical);
  for (const p of emptyTargets) {
    console.error(
      `  BLOCK  target key is ${JSON.stringify(p.canonical)} for ${p.docs.length} User row(s): ` +
      p.docs.map((d) => `${d.id}(${JSON.stringify(d.email)})`).join(", "),
    );
  }
  if (emptyTargets.length) {
    return abort(
      `${emptyTargets.length} group(s) have no valid target key. Nothing was written. ` +
      `There is no key this script could write that a session would ever produce.`,
    );
  }

  // -- 2c. PRECONDITION: no group KEY is held by an outside User. ------------
  // A second holder can only be a row whose STORED userID equals one of this
  // group's canonical ids. Forcing the key then puts two humans on one identity
  // — strictly worse than the duplicate.
  //
  // CHANGE 1 WIDENS THIS, and the widening is the load-bearing half. It now
  // checks every LOSING canonical too, not just the surviving one: those keys
  // are about to have their dependent rows swept onto the survivor, so an
  // outside row sitting on one of them would have ITS bookings, posts and orders
  // handed to a different human. Note that an outside row STORING a key which a
  // group member also stores is not reachable here — the matric edge would have
  // pulled it into the group — so what survives this filter is precisely the
  // dangerous case: a stranger squatting a key nobody in the group stores.
  const outside = [];
  for (const p of plans) {
    for (const key of [p.canonical, ...p.losingCanonicals]) {
      const holders = users.filter(
        (u) => u.userID === key &&
          !p.docs.some((d) => d.id === String(u._id?.$oid ?? u._id ?? "")),
      );
      for (const h of holders) {
        outside.push({
          canonical: p.canonical,
          key,
          id: String(h._id?.$oid ?? h._id ?? ""),
          email: h.email,
        });
      }
    }
  }
  for (const o of outside) {
    console.error(
      `  BLOCK  group key ${o.key} (group canonical ${o.canonical}) is ALSO the stored userID ` +
      `of User ${o.id} (email ${JSON.stringify(o.email)}), which is not in that group`,
    );
  }
  if (outside.length) {
    return abort(
      `${outside.length} canonical-id collision(s) with a User outside the group. Merging two ` +
      `humans onto one identity is not reversible by re-running. Resolve by hand first.`,
    );
  }

  // -- 3. Gather pre-images + counts for the backup and the verification. ----
  const before = {}; // before[canonical][coll][userID] = n
  for (const p of plans) {
    const keys = [p.canonical, ...p.sourceIDs];
    before[p.canonical] = {};
    for (const coll of [...DEPENDENTS, ...DEPENDENTS_OPTIONAL]) {
      before[p.canonical][coll] = {};
      for (const k of keys) before[p.canonical][coll][k] = await countKeyed(coll, k);
    }
    // Singleton-keyed pre-images (needed to merge them by value, and to restore).
    p.singletonRows = {};
    for (const coll of SINGLETON_KEYED) {
      p.singletonRows[coll] = [];
      for (const k of keys) {
        for (const d of await docsKeyed(coll, k)) p.singletonRows[coll].push(d);
      }
    }
    // Pre-image under EVERY key in the group, not just the survivor's: a losing
    // canonical may already carry a ProfileCompletion row, and the backup is the
    // only way back.
    p.profileCompletionBefore = [];
    for (const k of keys) {
      for (const d of await docsKeyed("ProfileCompletion", k)) p.profileCompletionBefore.push(d);
    }

    // Fold any ALREADY-RECORDED matric into the candidate set. A UserMatric row
    // under a loser's key is as much a claim about this human as an A-format
    // userID is, and ignoring it would let a third value survive the merge
    // unexamined.
    for (const r of p.singletonRows.UserMatric ?? []) {
      const m = typeof r.matric === "string" ? r.matric : null;
      if (m && !p.matricCandidates.includes(m)) p.matricCandidates.push(m);
    }
    if (p.matricCandidates.length > 1) {
      p.matricConflict = true;
      if (!p.needsFields.includes("matric")) p.needsFields.push("matric");
      if (!p.conflictNames.includes("userID(matric)")) p.conflictNames.push("userID(matric)");
      if (!p.flags.includes("MULTIPLE_MATRICS")) p.flags.push("MULTIPLE_MATRICS");
    }
    p.matricResolved = p.matricConflict ? null : (p.matricCandidates[0] ?? null);

    p.reason =
      `merge-by-canonical: ${p.docs.length} User rows resolved to ${p.canonical}` +
      (p.losingCanonicals.length
        ? ` (collapsing ${p.losingCanonicals.join(", ")} via shared matric)`
        : ``) +
      (p.conflictNames.length
        ? `; disagreed on ${p.conflictNames.join(", ")}`
        : `; no field conflicts`);
  }

  // -- 3b. Singleton emails that merely need NORMALIZING (not merging). ------
  // This is the "e0425010@u.nus.edu " row. It is ONE account; it does not need
  // a merge, it needs its stored address trimmed — and until it is trimmed, the
  // case-insensitive unique index in step 8 cannot see it as a duplicate of a
  // future clean registration for the same person.
  const toNormalize = [];
  for (const d of eligible) {
    if (d.email !== d.normalizedEmail) {
      toNormalize.push({ id: d.id, from: d.email, to: d.normalizedEmail });
    }
  }

  // -- 4. BACKUP everything affected, BEFORE any write. ---------------------
  mkdirSync(join(HERE, "backups"), { recursive: true });
  const backupPath = join(HERE, "backups", `merge-by-canonical-${fileStamp()}.json`);
  const backup = {
    generatedAt: new Date().toISOString(),
    mode: COMMIT ? "commit" : "dry-run",
    groupCount: plans.length,
    normalizeCount: toNormalize.length,
    emailNormalizations: toNormalize,
    uncanonicalRows: ineligible.map((r) => ({ id: r.id, email: r.email, reason: r.reason })),
    groups: plans.map((p) => ({
      canonical: p.canonical,
      canonicals: p.canonicals,
      losingCanonicals: p.losingCanonicals,
      survivorId: p.survivor.id,
      loserIds: p.losers.map((d) => d.id),
      sourceIDs: p.sourceIDs,
      set: p.set,
      fieldPlan: p.fieldPlan,
      needsFields: p.needsFields,
      matricCandidates: p.matricCandidates,
      matricResolved: p.matricResolved,
      flags: p.flags,
      dependentCountsBefore: before[p.canonical],
      // FULL pre-images: this file is the only way back.
      userDocs: p.docs.map((d) => d._raw),
      singletonRows: p.singletonRows,
      profileCompletionBefore: p.profileCompletionBefore,
    })),
  };
  try {
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`Backup written: ${backupPath}\n`);
  } catch (e) {
    return abort(
      `could not write the backup file (${e.message}). Refusing to proceed — every write ` +
      `below is irreversible without it.`,
    );
  }

  // -- 5. PRINT THE FULL INTENDED CHANGE SET (both modes, before any write). -
  console.log(`--- PLAN (${plans.length} group(s) to merge) ---`);
  for (const p of plans) {
    console.log(`\n${COMMIT ? "+" : "~"} canonical ${p.canonical}   (${p.docs.length} rows -> 1)`);
    if (p.losingCanonicals.length) {
      console.log(
        `      COLLAPSING CANONICALS: [${p.canonicals.join(", ")}] -> ${p.canonical}` +
        `   (losing keys: ${p.losingCanonicals.join(", ")}; grouped via shared matric)`,
      );
    }
    for (const d of p.docs) {
      console.log(
        `    ${d.id === p.survivor.id ? "KEEP  " : "DELETE"} _id=${d.id} ` +
        `canon=${d.canonical} ` +
        `userID=${JSON.stringify(d.userID)} email=${JSON.stringify(d.email)} ` +
        `hash=${d.hasHash ? "yes" : "no"} fields=${completeness(d)}/${FIELDS.length} ` +
        `created=${new Date(parseDate(d.createdAt)).toISOString()}`,
      );
    }
    for (const fp of p.fieldPlan) {
      const mark = fp.status === "conflict"
        ? "CONFLICT"
        : fp.status === "union" ? "UNION   " : fp.status === "agree" ? "agree   " : "absent  ";
      const shown = fp.status === "conflict"
        ? `CLEAR -> ${JSON.stringify(p.set[fp.field] ?? null)}   ` +
          `(distinct: ${fp.distinct.map((x) => JSON.stringify(x)).join(" | ")})` +
          (PROMPTABLE.has(FIELDS.find((x) => x.name === fp.field)?.flag ?? "")
            ? `  [prompted]`
            : `  [cleared, NOT prompted — cosmetic]`)
        : fp.status === "union"
          ? `MERGE -> ${JSON.stringify(fp.value)}   (from: ${fp.distinct.map((x) => JSON.stringify(x)).join(" | ")})`
          : fp.status === "agree"
            ? `keep ${JSON.stringify(fp.value)}`
            : `(nobody set it)`;
      console.log(`      ${mark} ${fp.field.padEnd(15)} ${shown}`);
    }
    console.log(
      `      ${p.matricConflict ? "CONFLICT" : "matric  "} ${"matric".padEnd(15)}` +
      (p.matricConflict
        ? `CLEAR -> no UserMatric row  (candidates: ${p.matricCandidates.join(" | ")})`
        : `${p.matricResolved ? `set ${p.matricResolved}` : "(none known)"}`),
    );
    console.log(`      userID          FORCE -> ${p.canonical}  (ownership key, never cleared)`);
    console.log(`      passwordHash    ${p.set.passwordHash ? "kept (never cleared)" : "NONE IN GROUP"}`);
    const dep = DEPENDENTS.map((c) => {
      const sum = Object.values(before[p.canonical][c]).reduce((a, b) => a + b, 0);
      return `${c}=${sum}`;
    }).join(" ");
    console.log(`      reassign [${p.sourceIDs.join(", ") || "-"}] -> ${p.canonical}   deps: ${dep}`);
    for (const coll of SINGLETON_KEYED) {
      const rows = p.singletonRows[coll] ?? [];
      if (rows.length) {
        console.log(`      ${coll}: ${rows.length} row(s) under [${
          [...new Set(rows.map((r) => r.userID))].join(", ")}] -> merged onto ${p.canonical}`);
      }
    }
    console.log(
      `      ProfileCompletion: ${p.needsFields.length
        ? `FLAG needsFields=${JSON.stringify(p.needsFields)}`
        : p.conflictNames.length
          ? `NO ROW (conflicts were cosmetic only: ${p.conflictNames.join(", ")} — cleared, not prompted)`
          : "not needed (no conflicts)"}`,
    );
    if (p.flags.length) console.log(`      flags: ${p.flags.join(", ")}`);
  }

  console.log(`\n--- EMAIL NORMALIZATION (${toNormalize.length} row(s)) ---`);
  for (const n of toNormalize) {
    console.log(`  ${COMMIT ? "+" : "~"} _id=${n.id}  ${JSON.stringify(n.from)} -> ${JSON.stringify(n.to)}`);
  }
  if (!toNormalize.length) console.log(`  (none — every stored address is already normalized)`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing was written. Re-run with --commit to apply.`);
  }

  // -- 6. APPLY. Ordering is crash-safe: every read-modify-write that could be
  //       lost happens BEFORE the delete that would lose it. ----------------
  const reassigned = Object.fromEntries(DEPENDENTS.map((c) => [c, 0]));
  let usersDeleted = 0;
  let flagsWritten = 0;
  let emailsNormalized = 0;

  if (COMMIT) {
    console.log(`\n--- APPLYING ---`);
    for (const p of plans) {
      const label = `group ${p.canonical}`;
      try {
        // 6a. Dependent rows onto the canonical key, BEFORE any delete.
        for (const coll of DEPENDENTS) {
          for (const src of p.sourceIDs) {
            reassigned[coll] += await reassignRaw(coll, src, p.canonical, failures, label);
          }
        }

        // 6b. UserRole: unique on userID, so merge BY VALUE (union of roles),
        //     then drop the source rows. An updateMany here would be a
        //     duplicate-key writeError, not an exception.
        const roleRows = p.singletonRows.UserRole ?? [];
        if (roleRows.length) {
          const roles = [...new Set(roleRows.flatMap((r) => (Array.isArray(r.roles) ? r.roles : [])))];
          const rep = roleRows.find((r) => r.userID === p.canonical) ?? roleRows[0];
          const upd = await raw({
            update: "UserRole",
            updates: [{
              q: { userID: p.canonical },
              u: {
                $set: { roles, updatedAt: nowExt(), updatedBy: "merge-by-canonical" },
                // I-9: the legacy scalar mirror is "" on insert, never null.
                $setOnInsert: { userID: p.canonical, role: typeof rep?.role === "string" ? rep.role : "" },
              },
              upsert: true,
              multi: false,
            }],
          });
          const r = inspectWriteReply(upd, `${label} UserRole upsert`);
          if (!r.ok || r.writeErrors.length) {
            failures.push(`${label}: UserRole upsert FAILED: ${JSON.stringify(r.writeErrors)}`);
          }
          for (const src of p.sourceIDs) {
            const del = await raw({ delete: "UserRole", deletes: [{ q: { userID: src }, limit: 0 }] });
            const dr = inspectWriteReply(del, `${label} UserRole delete ${src}`);
            if (!dr.ok || dr.writeErrors.length) {
              failures.push(`${label}: UserRole delete ${src} FAILED: ${JSON.stringify(dr.writeErrors)}`);
            }
          }
        }

        // 6c. UserMatric: one value or none. On conflict the canonical row is
        //     REMOVED — leaving a coin-flipped matric in place is the exact
        //     failure the flag exists to avoid, and the gate only re-prompts
        //     when there is no row.
        for (const src of p.sourceIDs) {
          const del = await raw({ delete: "UserMatric", deletes: [{ q: { userID: src }, limit: 0 }] });
          const dr = inspectWriteReply(del, `${label} UserMatric delete ${src}`);
          if (!dr.ok || dr.writeErrors.length) {
            failures.push(`${label}: UserMatric delete ${src} FAILED: ${JSON.stringify(dr.writeErrors)}`);
          }
        }
        if (p.matricConflict) {
          const del = await raw({
            delete: "UserMatric",
            deletes: [{ q: { userID: p.canonical }, limit: 0 }],
          });
          const dr = inspectWriteReply(del, `${label} UserMatric clear`);
          if (!dr.ok || dr.writeErrors.length) {
            failures.push(`${label}: UserMatric clear FAILED: ${JSON.stringify(dr.writeErrors)}`);
          }
        } else if (p.matricResolved) {
          const upd = await raw({
            update: "UserMatric",
            updates: [{
              q: { userID: p.canonical },
              u: {
                $set: { matric: p.matricResolved },
                $setOnInsert: { userID: p.canonical, source: "merge-by-canonical" },
              },
              upsert: true,
              multi: false,
            }],
          });
          const r = inspectWriteReply(upd, `${label} UserMatric upsert`);
          if (!r.ok || r.writeErrors.length) {
            failures.push(`${label}: UserMatric upsert FAILED: ${JSON.stringify(r.writeErrors)}`);
          }
        }

        // 6d. ProfileCompletion flag — BEFORE the delete, so a crash between
        //     here and 6f leaves an account that is flagged but not yet merged
        //     (harmless: the user re-enters data that is still there) rather
        //     than merged but not flagged (silent data loss).
        //
        //     $setOnInsert for flaggedAt, and resolvedAt is NEVER written by
        //     this script: re-running must not un-resolve a prompt the user has
        //     already answered.
        if (p.needsFields.length) {
          const upd = await raw({
            update: "ProfileCompletion",
            updates: [{
              q: { userID: p.canonical },
              u: {
                $set: { needsFields: p.needsFields, reason: p.reason },
                $setOnInsert: { userID: p.canonical, flaggedAt: nowExt() },
              },
              upsert: true,
              multi: false,
            }],
          });
          const r = inspectWriteReply(upd, `${label} ProfileCompletion`);
          if (!r.ok || r.writeErrors.length) {
            failures.push(`${label}: ProfileCompletion upsert FAILED: ${JSON.stringify(r.writeErrors)}`);
          } else {
            flagsWritten++;
          }
        }

        // 6e. The survivor. RAW, not the Prisma delegate: `modules`, `userCCA`
        //     and `imageKey` exist in Mongo but are NOT in the Prisma User
        //     model, so db.user.update() cannot address them at all.
        const upd = await raw({
          update: "User",
          updates: [{ q: { _id: { $oid: p.survivor.id } }, u: { $set: p.set }, multi: false }],
        });
        const r = inspectWriteReply(upd, `${label} survivor $set`);
        if (!r.ok || r.writeErrors.length) {
          // A $jsonSchema rejection lands HERE, as code 121 with ok:1.
          failures.push(
            `${label}: survivor ${p.survivor.id} $set FAILED (validator?): ` +
            JSON.stringify(r.writeErrors),
          );
          console.error(`  *** ${label}: survivor update failed — NOT deleting losers ***`);
          continue; // never delete a loser when the survivor did not take the merge
        }

        // 6f. Losers LAST. Prisma's delegate is used so Session / Account /
        //     Authenticator cascade with the row.
        for (const d of p.losers) {
          try {
            await db.user.delete({ where: { id: d.id } });
            usersDeleted++;
          } catch {
            /* already gone — idempotent re-run */
          }
        }
      } catch (e) {
        failures.push(`${label}: apply error: ${e.message}`);
        console.error(`  *** ERROR on ${label}: ${e.message} — continuing ***`);
      }
    }

    // 6g. Email normalization for every remaining row (merged or singleton).
    for (const n of toNormalize) {
      const upd = await raw({
        update: "User",
        updates: [{ q: { _id: { $oid: n.id } }, u: { $set: { email: n.to } }, multi: false }],
      });
      const r = inspectWriteReply(upd, `normalize ${n.id}`);
      if (!r.ok || r.writeErrors.length) {
        failures.push(`email normalize ${n.id} (${n.from}) FAILED: ${JSON.stringify(r.writeErrors)}`);
      } else if (r.nModified) {
        emailsNormalized++;
      }
    }
  }

  // -- 7. VERIFY. Names every offender (I-16); non-zero exit on any failure. -
  console.log(`\n--- VERIFICATION (${COMMIT ? "recount" : "predicted"}) ---`);
  for (const p of plans) {
    for (const coll of DEPENDENTS) {
      const beforeSum = Object.values(before[p.canonical][coll]).reduce((a, b) => a + b, 0);
      let afterCanon = beforeSum;
      let afterSrc = 0;
      if (COMMIT) {
        afterCanon = await countKeyed(coll, p.canonical);
        afterSrc = 0;
        for (const s of p.sourceIDs) afterSrc += await countKeyed(coll, s);
      }
      const ok = afterCanon === beforeSum && afterSrc === 0;
      if (!ok) {
        failures.push(
          `VERIFY FAIL ${p.canonical} ${coll}: before=${beforeSum} canonical=${afterCanon} sources=${afterSrc}`,
        );
        console.log(
          `  *** VERIFY FAILED canonical=${p.canonical} coll=${coll} before=${beforeSum} ` +
          `canonical=${afterCanon} sources=${afterSrc} ***`,
        );
      } else if (beforeSum > 0) {
        console.log(`  ${p.canonical} ${coll}: ${beforeSum} -> canonical=${afterCanon} sources=${afterSrc} [OK]`);
      }
    }

    if (!COMMIT) continue;

    // Exactly one User row for this canonical id, and it carries the key.
    // Every canonical in the group, not just the survivor's: after the merge the
    // whole component must be ONE row, and a row whose email still canonicalises
    // to a LOSING key is exactly the duplicate this change exists to remove.
    const rows = (await findAll(db, "User", { _id: 1, email: 1, userID: 1 }))
      .filter((u) => p.canonicals.includes(canonicalUserID(typeof u.email === "string" ? u.email : "")));
    if (rows.length !== 1) {
      failures.push(`VERIFY FAIL ${p.canonical}: ${rows.length} User row(s) remain (expected 1) — ` +
        `_ids ${rows.map((u) => String(u._id?.$oid ?? u._id)).join(", ")}`);
      console.log(`  *** VERIFY FAILED ${p.canonical}: ${rows.length} User rows remain ***`);
    } else if (rows[0].userID !== p.canonical) {
      failures.push(`VERIFY FAIL ${p.canonical}: survivor userID is ${JSON.stringify(rows[0].userID)}`);
      console.log(`  *** VERIFY FAILED ${p.canonical}: survivor userID=${JSON.stringify(rows[0].userID)} ***`);
    }

    // Flag present iff there were conflicts.
    const pc = await docsKeyed("ProfileCompletion", p.canonical);
    if (p.needsFields.length && !pc.length) {
      failures.push(`VERIFY FAIL ${p.canonical}: conflicts ${JSON.stringify(p.needsFields)} but no ProfileCompletion row`);
      console.log(`  *** VERIFY FAILED ${p.canonical}: missing ProfileCompletion row ***`);
    }

    // On a matric conflict there must be NO UserMatric row, or the gate will
    // not prompt and the coin-flip value stands.
    const um = await docsKeyed("UserMatric", p.canonical);
    if (p.matricConflict && um.length) {
      failures.push(`VERIFY FAIL ${p.canonical}: matric conflicted but UserMatric row still present ` +
        `(matric=${JSON.stringify(um[0]?.matric)})`);
      console.log(`  *** VERIFY FAILED ${p.canonical}: stale UserMatric row ***`);
    }
    if (!p.matricConflict && p.matricResolved && um.length !== 1) {
      failures.push(`VERIFY FAIL ${p.canonical}: expected 1 UserMatric row, found ${um.length}`);
    }
    for (const s of p.sourceIDs) {
      for (const coll of SINGLETON_KEYED) {
        const left = await docsKeyed(coll, s);
        if (left.length) {
          failures.push(`VERIFY FAIL ${p.canonical}: ${left.length} ${coll} row(s) still under dead key ${s}`);
          console.log(`  *** VERIFY FAILED ${p.canonical}: ${coll} rows remain under ${s} ***`);
        }
      }
    }
  }

  if (COMMIT) {
    const stillDirty = (await findAll(db, "User", { _id: 1, email: 1 }))
      .filter((u) => typeof u.email === "string" && u.email !== normalizeEmail(u.email));
    for (const u of stillDirty) {
      failures.push(`VERIFY FAIL: User ${String(u._id?.$oid ?? u._id)} email ${JSON.stringify(u.email)} not normalized`);
      console.log(`  *** VERIFY FAILED: un-normalized email ${JSON.stringify(u.email)} ***`);
    }
  }

  // -- 8. RECURRENCE GUARD (commit only, LAST, only if zero failures). -------
  //
  // See the README section "Preventing recurrence" for what these do and do
  // NOT catch. Index creation is deliberately last: an index built over data
  // that is still half-merged either fails on a duplicate or, worse, succeeds
  // and cements the wrong shape.
  if (COMMIT) {
    if (failures.length) {
      console.log(
        `\n*** ${failures.length} failure(s) — NOT creating the uniqueness indexes. The DB is ` +
        `left in a resolvable state: fix the named offenders and re-run. ***`,
      );
    } else {
      // 8a. ProfileCompletion.userID unique (also created by `prisma db push`).
      await raw({
        createIndexes: "ProfileCompletion",
        indexes: [{ key: { userID: 1 }, name: "userID_unique", unique: true }],
      }).catch((e) => console.log(`ProfileCompletion userID index: ${e.message}`));

      // 8b. Case-insensitive unique email. Folds CASE only — which is why every
      //     stored address was normalized in 6g first: after that pass the
      //     stored values carry no whitespace, so case-folding is sufficient
      //     for them. It does NOT make future whitespace-bearing writes safe.
      try {
        await raw({
          createIndexes: "User",
          indexes: [{
            key: { email: 1 },
            name: "email_unique_ci",
            unique: true,
            collation: { locale: "en", strength: 2 },
          }],
        });
        console.log(`\nemail_unique_ci on User.email: present.`);
      } catch (e) {
        const msg = String(e.message || e);
        if (/already exists|IndexOptionsConflict|IndexKeySpecsConflict/i.test(msg)) {
          console.log(`\nemail_unique_ci already present — no-op.`);
        } else {
          console.log(`\nemail_unique_ci: ${msg}`);
          failures.push(`email_unique_ci: ${msg}`);
        }
      }

      // 8c. THE STRONGER GUARD: unique on User.userID, partial to string-typed
      //     non-empty values. This is what actually catches the class, because
      //     userID is the value derived from the email — two rows that mean one
      //     human collide on it however their raw addresses are spelled.
      //
      //     CONDITIONAL, and it must stay conditional: ~515 legacy singletons
      //     still carry an A-format matric in userID (finding #9, deliberately
      //     NOT rewritten), so if any two of those coincide the index cannot be
      //     built and forcing it would be an outage. The duplicate check runs
      //     first and the index is skipped, loudly, if it would fail.
      const dupCheck = await raw({
        aggregate: "User",
        pipeline: [
          { $match: { userID: { $type: "string", $ne: "" } } },
          { $group: { _id: "$userID", n: { $sum: 1 }, ids: { $push: { $toString: "$_id" } } } },
          { $match: { n: { $gt: 1 } } },
        ],
        cursor: {},
      });
      const dups = dupCheck?.cursor?.firstBatch ?? [];
      if (dups.length) {
        console.log(
          `\nuserID_unique NOT created: ${dups.length} userID value(s) are still shared. ` +
          `This is not a failure of the merge — these are distinct canonical identities ` +
          `that happen to store the same legacy matric. Offenders:`,
        );
        for (const d of dups) console.log(`  ${d._id}: ${numify(d.n)} rows (${d.ids.join(", ")})`);
      } else {
        try {
          await raw({
            createIndexes: "User",
            indexes: [{
              key: { userID: 1 },
              name: "userID_unique",
              unique: true,
              partialFilterExpression: { userID: { $type: "string" } },
            }],
          });
          console.log(`userID_unique on User.userID: present (partial: string-typed only).`);
        } catch (e) {
          const msg = String(e.message || e);
          if (/already exists|IndexOptionsConflict|IndexKeySpecsConflict/i.test(msg)) {
            console.log(`userID_unique already present — no-op.`);
          } else {
            console.log(`userID_unique: ${msg}`);
            failures.push(`userID_unique: ${msg}`);
          }
        }
      }
    }
  }

  // -- 9. Audit-only counts (not reassigned). -------------------------------
  const auditRows = plans.flatMap((p) =>
    DEPENDENTS_OPTIONAL.map((coll) => {
      const sum = Object.values(before[p.canonical][coll] ?? {}).reduce((a, b) => a + b, 0);
      return sum > 0 ? `${p.canonical} ${coll}=${sum}` : null;
    }),
  ).filter(Boolean);
  if (auditRows.length) {
    console.log(`\nAUDIT-ONLY (counted, NOT reassigned — same scope call as merge-accounts): ${auditRows.join("  ")}`);
  }

  // -- 10. Summary. ---------------------------------------------------------
  console.log(`\n=== SUMMARY ===`);
  console.log(`Mode:                  ${COMMIT ? "COMMIT" : "DRY RUN"}`);
  console.log(`Merge groups (>1 row): ${plans.length}`);
  console.log(`  spanning >1 canonical: ${plans.filter((p) => p.losingCanonicals.length).length}` +
    (plans.some((p) => p.losingCanonicals.length)
      ? `  [${plans.filter((p) => p.losingCanonicals.length).map((p) => `${p.canonical}<-${p.losingCanonicals.join("/")}`).join(", ")}]`
      : ``));
  console.log(`Groups with conflicts: ${plans.filter((p) => p.conflictNames.length).length}`);
  console.log(`  -> prompted (flagged):  ${plans.filter((p) => p.needsFields.length).length}`);
  console.log(`  -> cosmetic only (cleared, NO flag row): ${
    plans.filter((p) => p.conflictNames.length && !p.needsFields.length).length}`);
  console.log(`userCCA unions applied: ${
    plans.filter((p) => p.fieldPlan.some((f) => f.field === "userCCA" && f.status === "union")).length}`);
  console.log(`userCCA CONFLICTs:     ${
    plans.filter((p) => p.fieldPlan.some((f) => f.field === "userCCA" && f.status === "conflict")).length}  (must be 0)`);
  console.log(`Users deleted:         ${COMMIT ? usersDeleted : `(dry-run: ${plans.reduce((a, p) => a + p.losers.length, 0)} planned)`}`);
  console.log(`ProfileCompletion:     ${COMMIT ? flagsWritten : `(dry-run: ${plans.filter((p) => p.needsFields.length).length} planned)`}`);
  console.log(`Emails normalized:     ${COMMIT ? emailsNormalized : `(dry-run: ${toNormalize.length} planned)`}`);
  console.log(`Rows reassigned:       ${COMMIT ? JSON.stringify(reassigned) : "(dry-run: none written)"}`);
  console.log(`Backup:                ${backupPath}`);
  console.log(`Failures:              ${failures.length}`);
  if (failures.length) {
    console.log(`\nFAILURES (I-16 — every offender named):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
