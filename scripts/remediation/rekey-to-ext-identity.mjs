/**
 * Moves an EXISTING account from a legacy identity key to an `EXT:` allowlist
 * pin, carrying its whole history with it.
 *
 *   node scripts/remediation/rekey-to-ext-identity.mjs \
 *     --email vincent.koh@nus.edu.sg --from VKTJ66 --to EXT:VINCENT_KOH \
 *     --actor E1633673
 *   ... --commit      to apply
 *
 * Dry run by DEFAULT. It prints a per-collection before/after table and exits 1
 * without writing anything if ANY refusal fires.
 *
 * ===========================================================================
 * WHAT THIS IS FOR, AND HOW IT DIFFERS FROM provision-ext-account.mjs
 * ===========================================================================
 *
 * provision-ext-account.mjs CREATES an identity: an AuthAllowlist row plus a
 * brand-new `User` row with no passwordHash. It REFUSES when a `User` row
 * already exists (`USER_ALREADY_EXISTS`), and that refusal is correct — it must
 * never overwrite a live account.
 *
 * This script is the other case: THE PERSON ALREADY HAS AN ACCOUNT, with a
 * password, a display name, and years of rows filed under a legacy key that
 * `canonicalUserID` cannot derive from their address. Under the deployed code
 * their session resolves to `userID: null`, so they can neither book nor SEE
 * the bookings they already hold. Pinning the address alone does not fix that:
 * it mints a NEW key, and every existing row of theirs is still filed under the
 * OLD one. The rows have to move, or the pin quietly orphans their history.
 *
 * ===========================================================================
 * THE THREE BUCKETS. Every collection in this database is in exactly one.
 * ===========================================================================
 *
 * The taxonomy is NOT invented here. It is the one `deleteUserAccountCascade`
 * (src/server/api/services/userAdmin.ts) already had to settle, including its
 * long "DELIBERATELY NOT DELETED, and why" block — read that before changing
 * any list below. What changes for a RE-KEY is only the verb.
 *
 * (A) OWNERSHIP — RE-KEYED. Rows the account owns, and which the app finds by
 *     looking up this key. Leaving one behind is data silently orphaned: the
 *     row still exists, nothing reports an error, and the user simply cannot
 *     see it. All twelve are in the cascade's delete set for the same reason
 *     they are here — they are the account's own records.
 *
 * (B) HISTORY / PROVENANCE — COUNTED AND REPORTED, NEVER RE-KEYED. Rows that
 *     RECORD SOMETHING THAT HAPPENED, in which this key appears as a statement
 *     of fact about the past ("the actor was VKTJ66 at 14:02"). Rewriting them
 *     makes the record assert something that never happened. The cascade
 *     declines to DELETE these for the mirror-image reason. They are counted
 *     and printed so the operator sees the split rather than discovering it.
 *
 * (C) UNRESOLVED KEY FORMAT — COUNTED, AND A NON-ZERO COUNT IS A REFUSAL.
 *     The supper domain. userAdmin.ts is explicit that nobody knows whether
 *     `Order.userID` holds this key format at all, and that the last person to
 *     guess got it wrong in both directions. An `updateMany` is safe when the
 *     count is zero and is a decision nobody has authority to make when it is
 *     not — so a non-zero count stops the run and hands it to a human. This is
 *     the same "cannot verify ⇒ stop" posture preflight-scrc-validators.mjs
 *     takes on an uninterpretable validator.
 *
 * (D) NOT AN IDENTITY KEY AT ALL — NEVER TOUCHED. Enumerated below, because
 *     "we did not think about it" and "we thought about it and it must not
 *     move" look identical in a diff. `Session.userId`, `Account.userId` and
 *     `Authenticator.userId` are the dangerous ones: they are MONGO OBJECTIDS
 *     referencing `User._id`, not app identity keys, and they LOOK like the
 *     others. Writing an EXT pin into one breaks NextAuth's adapter relations
 *     and Prisma's `onDelete: Cascade` for that account.
 *
 * ===========================================================================
 * WHY RoleAuditLog IS NOT RE-KEYED — the decision, stated so it is not silent
 * ===========================================================================
 *
 * schema.prisma calls RoleAuditLog append-only BY CODE CONTRACT: "There is no
 * update or delete path in any router, and none may be added." An updateMany
 * here would be the first violation of that contract, performed by a script,
 * on the one collection whose entire value is that it cannot be edited.
 *
 * And the rows would become FALSE. `actorUserID: "VKTJ66"` does not mean "this
 * person"; it means "the actor was keyed VKTJ66 when this happened", which is
 * true and will stay true forever. Rewriting it to the pin produces a log
 * claiming an identity acted before that identity existed.
 *
 * THE COST IS REAL AND IS NOT HIDDEN: `admin.listAuditLog` filtered by the pin
 * will NOT return the pre-migration half of this account's trail. That is why
 * this script writes an `identity.rekey` row carrying the old key in
 * `rolesBefore` and the pin in `rolesAfter` — that row is the JOIN, and it is
 * the reason the split is navigable rather than lost. The dry run prints the
 * affected counts under (B) so the operator sees exactly how much history stays
 * behind before they decide to proceed.
 *
 * The same argument covers `BookingLogs` and every `createdBy` / `updatedBy` /
 * `decidedBy` provenance string.
 *
 * BookingLogs is the one worth checking rather than asserting, because the
 * counts are not small (104 rows for the first account migrated). Three
 * independent things say it stays:
 *   - userAdmin.ts's not-deleted block: "BookingLogs — A log. Same class as
 *     the above [RoleAuditLog]."
 *   - merge-by-canonical.mjs — THE CLOSEST PRECEDENT, since it moves a losing
 *     account's rows onto a winning key exactly as this does — lists it in
 *     `DEPENDENTS_OPTIONAL`: "Counted, reported, NOT reassigned."
 *   - nothing in `src/` reads or writes the collection at all. `grep -rn
 *     BookingLogs src/` returns one hit and it is a comment. So no user-facing
 *     surface can orphan anything by leaving it: there is no surface.
 * If a future feature starts reading BookingLogs by userID, it moves to
 * bucket (A) and this note is the thing that should be re-read.
 *
 * WHERE THIS DIVERGES FROM merge-by-canonical.mjs, deliberately: that script
 * has `Order` in its DEPENDENTS (it moves supper orders). This one refuses on
 * them instead. userAdmin.ts's later and much longer analysis concluded the key
 * format there was never established and that the last person to guess got it
 * wrong in both directions — so the newer reasoning wins. It is moot whenever
 * the count is zero, which is the only state this script will proceed from.
 *
 * Note also that merge-by-canonical's dependent list is a STRICT SUBSET of
 * bucket (A) below: it predates ProfileCompletion, CcaHead, EventSignup,
 * CcaApplication and PendingRoleGrant. Any list of "the keyed collections"
 * copied from a document or an older script is stale by construction; the
 * schema is the source, and bucket (D) exists so that re-deriving it from the
 * schema is checkable rather than a fresh judgement call every time.
 *
 * ===========================================================================
 * REFUSALS — every one aborts the whole run, before any write
 * ===========================================================================
 *   MISSING_ARGS            --email / --from / --to / --actor not all supplied.
 *   PIN_NOT_EXT             --to fails EXT_ID. The namespace is the mechanism
 *                           (see src/lib/identity.ts): a pin that is not in it
 *                           mints no identity at all, so this would move 68
 *                           rows onto a key no session can ever produce.
 *   FROM_IS_EXT             --from is already an EXT pin. This script moves a
 *                           LEGACY key to a pin; pin-to-pin is a different
 *                           operation with different hazards and does not have
 *                           one here.
 *   FROM_IS_BLANK           --from is empty or whitespace. `where: {userID:""}`
 *                           is the sentinel bug class — it matches every
 *                           ""-keyed row in the database, i.e. a stranger's.
 *   FROM_EQUALS_TO          nothing to do, and an updateMany from a key to
 *                           itself would produce a misleading "moved N rows".
 *   EMAIL_IS_CANONICAL      the address already derives an identity of its own.
 *                           Pinning it gives one human two identities — the
 *                           same refusal addAuthAllowlistEntry makes.
 *   NO_USER_ROW             no `User` row for --email. Use
 *                           provision-ext-account.mjs; this script only MOVES.
 *   USER_KEY_MISMATCH       the `User` row's stored userID is not --from. The
 *                           operator has the wrong old key, and every count
 *                           below would be measuring somebody else's rows.
 *   FROM_KEY_NOT_EXCLUSIVE  more than one `User` row carries --from. `User.userID`
 *                           has NO unique index, and the split-identity rows in
 *                           this database are real (fix-claresta-duplicate.mjs
 *                           documents an account whose stored userID is another
 *                           live human's key). Re-keying by `where: {userID}`
 *                           would carry that stranger's rows across too.
 *   TARGET_KEY_OCCUPIED     ANY row already exists under --to, in ANY collection.
 *                           THE WORST OUTCOME AVAILABLE HERE: the move would
 *                           MERGE TWO IDENTITIES, and no unique index catches it
 *                           on the non-unique collections (Bookings, Posts,
 *                           UserCCA, Gym, CcaApplication).
 *   EMAIL_PINNED_ELSEWHERE  an AuthAllowlist row pins --email to a different pin.
 *   PIN_PINNED_ELSEWHERE    an AuthAllowlist row pins --to to a different email.
 *   ALLOWLIST_INDEXES_MISSING
 *                           `email_unique` / `pin_unique` are not on the
 *                           collection, so M3 does not exist and the create
 *                           below is not protected against a concurrent one.
 *                           Run create-auth-allowlist.mjs first.
 *   UNRESOLVED_DOMAIN_ROWS  bucket (C) is non-empty. See above.
 *
 * ===========================================================================
 * ATOMICITY, IDEMPOTENCE, AND WHAT A FAILURE LEAVES BEHIND
 * ===========================================================================
 *
 * ONE INTERACTIVE `db.$transaction`. The document count is irrelevant to the
 * budget — 68 bookings move in ONE `updateMany`, which is one command — so the
 * whole migration is ~15 operations regardless of how much history the account
 * has. That is far inside both Prisma's transaction timeout (raised explicitly
 * below rather than left to the 5s default) and MongoDB's 16MB oplog ceiling.
 * Splitting it was considered and rejected: a half-applied identity move is a
 * state in which the person's bookings are under one key and their roles under
 * another, and no ordering makes that safe to leave sitting.
 *
 * A failed run therefore writes NOTHING and is re-runnable as-is.
 *
 * A SUCCESSFUL RUN RE-RUN IS A CLEAN NO-OP, NOT A REFUSAL. `ALREADY_MIGRATED`
 * is detected up front — allowlist row present with exactly this (email, pin),
 * the `User` row already carrying the pin, and zero rows under the old key —
 * and exits 0. A refusal here would look like an error to an operator who is
 * merely re-checking their work, and an operator who is told "error" when the
 * answer is "done" starts investigating a healthy system.
 *
 * MongoDB will not implicitly CREATE a collection inside a transaction, so
 * `AuthAllowlist` must already exist. ALLOWLIST_INDEXES_MISSING proves it does:
 * `listIndexes` cannot report two unique indexes on a collection that is absent.
 */

import { PrismaClient } from "@prisma/client";
import {
  canonicalUserID,
  normalizeEmail,
  isExtUserID,
} from "./lib/identity.mjs";
import { isCommit, banner, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();

/** `--flag value`. Same shape as provision-ext-account.mjs. */
function argOf(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
}

const RAW_EMAIL = argOf("--email");
const RAW_FROM = argOf("--from");
const RAW_TO = argOf("--to");
const RAW_ACTOR = argOf("--actor");

const EMAIL = RAW_EMAIL === null ? null : normalizeEmail(RAW_EMAIL);
// `--to` gets the SAME transform the server's extUserIDSchema applies
// (.trim().toUpperCase()), so a pin typed here and a pin typed into the admin
// UI cannot diverge into two spellings of one key.
const TO = RAW_TO === null ? null : RAW_TO.trim().toUpperCase();
// `--from` is a LEGACY key and is NOT uppercased. It is whatever is actually in
// the column; "VKTJ66" and "A0221446M" happen to be upper case, but inventing a
// transform here would silently fail to match a mixed-case legacy value and
// report "0 rows to move" for an account with 68 of them.
const FROM = RAW_FROM === null ? null : RAW_FROM.trim();
const ACTOR = RAW_ACTOR === null ? null : RAW_ACTOR.trim();

const refusals = [];
const refuse = (code, why) => refusals.push({ code, why });

/* ==========================================================================
 * BUCKET (A) — OWNERSHIP. These move.
 *
 * `model`  the Prisma accessor.
 * `field`  the column holding the identity key.
 * `unique` whether a unique index covers it. Documented because it decides
 *          what happens on a collision: a unique collection FAILS the
 *          updateMany (loud, transaction aborts), a non-unique one silently
 *          MERGES. TARGET_KEY_OCCUPIED is what protects the second kind, and
 *          that is the whole reason the pre-check covers every collection
 *          rather than just the interesting ones.
 * ========================================================================== */
const OWNERSHIP = [
  { model: "bookings", field: "userID", unique: false, note: "the account's room bookings" },
  { model: "userRole", field: "userID", unique: true, note: "THE authorization row" },
  { model: "userMatric", field: "userID", unique: true, note: "matriculation number" },
  { model: "profileCompletion", field: "userID", unique: true, note: "post-merge prompt" },
  { model: "userCCA", field: "userID", unique: false, note: "CCA membership" },
  { model: "ccaHead", field: "userID", unique: true, note: "CCA headship scopes ([userID,ccaID])" },
  { model: "eventSignup", field: "userID", unique: true, note: "event signups ([eventID,userID])" },
  { model: "ccaApplication", field: "userID", unique: false, note: "CCA applications they filed" },
  { model: "posts", field: "userID", unique: false, note: "their posts" },
  { model: "gym", field: "userID", unique: false, note: "gym key-holder records" },
  { model: "pendingRoleGrant", field: "userID", unique: true, note: "unclaimed grant for this key" },
];

/* ==========================================================================
 * BUCKET (B) — HISTORY / PROVENANCE. Counted, reported, NEVER moved.
 * ========================================================================== */
const HISTORY = [
  { model: "roleAuditLog", field: "actorUserID", note: "who acted, AT THE TIME (append-only)" },
  { model: "roleAuditLog", field: "targetUserID", note: "who was acted on, AT THE TIME" },
  { model: "bookingLogs", field: "userID", note: "a log — same class as the audit log" },
  { model: "bulkRoleImport", field: "actorUserID", note: "who ran a bulk import" },
  { model: "ccaApplication", field: "decidedBy", note: "who decided somebody else's application" },
  { model: "ccaInterviewNote", field: "authorUserID", note: "notes they wrote about OTHER applicants" },
  { model: "ccaInterviewSlot", field: "createdBy", note: "slot provenance; other applicants hold seats" },
  { model: "event", field: "createdBy", note: "the event belongs to the CCA, not the filer" },
  { model: "event", field: "updatedBy", note: "provenance string" },
  { model: "ccaProfile", field: "updatedBy", note: "provenance string, not a reference" },
  { model: "facilityAccess", field: "updatedBy", note: "provenance string" },
  { model: "systemFlag", field: "updatedBy", note: "provenance string" },
  { model: "userRole", field: "updatedBy", note: "provenance string" },
  { model: "pendingRoleGrant", field: "createdBy", note: "who created somebody else's grant" },
  { model: "authAllowlist", field: "addedBy", note: "who issued somebody else's pin" },
];

/* ==========================================================================
 * BUCKET (C) — UNRESOLVED KEY FORMAT. Non-zero here STOPS THE RUN.
 *
 * userAdmin.ts, verbatim: "the key format is still unresolved ... Raise it with
 * the owner rather than guessing at the key." That was written about deleting.
 * An updateMany is gentler — a wrong guess moves nothing rather than destroying
 * something — but SupperGroup carries DENORMALIZED aggregates (numOrders,
 * userIdList, totalPrice, currentFoodCost) that a partial move would leave
 * disagreeing with the Orders they summarise. So: count, and if anything is
 * there, stop and let a human decide.
 * ========================================================================== */
const UNRESOLVED = [
  { model: "order", field: "userID", note: "supper orders — key format unresolved" },
  { model: "supperGroup", field: "ownerId", note: "supper group owner" },
  { model: "supperGroup", field: "userIdList", note: "supper group members (ARRAY)", isArray: true },
];

/* ==========================================================================
 * BUCKET (D) — NOT AN IDENTITY KEY. Never touched. Listed so that "we thought
 * about it" is distinguishable from "we forgot".
 *
 *   Session.userId          MONGO OBJECTID -> User._id. NextAuth adapter
 *   Account.userId          relations and Prisma's `onDelete: Cascade` ride on
 *   Authenticator.userId    these. They LOOK like the columns above and are a
 *                           completely different namespace; writing a pin into
 *                           one detaches the account from its own sessions.
 *   PasswordResetSession    keyed by EMAIL, and the email does not change here.
 *   BookingLock.key         ephemeral lock keys, seconds of lifetime.
 *   EventLock.key           likewise.
 *   RateLimit.key           likewise (and buckets expire).
 *   FoodOrder / FoodMenu    no identity column at all.
 *   Crowd / Counter /       no identity column at all.
 *   Restaurants
 *   User.userID             moved, but by _id and separately — see step 2. It
 *                           is the ONE row this script updates rather than
 *                           updateMany's, because `User.userID` has no unique
 *                           index and a `where: {userID}` there can match two
 *                           people (FROM_KEY_NOT_EXCLUSIVE).
 * ========================================================================== */

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** Count rows where `field` holds `key`. `isArray` switches to a `has` filter. */
async function countKey(model, field, key, isArray = false) {
  const where = { [field]: isArray ? { has: key } : key };
  return db[model].count({ where });
}

async function main() {
  banner("rekey-to-ext-identity.mjs", COMMIT);

  /* ---- 0. arguments ---------------------------------------------------- */
  if (!EMAIL || !FROM || !TO || !ACTOR) {
    return abort(
      "MISSING_ARGS — all four are required:\n" +
        "  --email <address>   the account's address (will be pinned)\n" +
        "  --from  <old key>   the legacy identity key its rows are filed under\n" +
        "  --to    <EXT:PIN>   the new pin\n" +
        "  --actor <userID>    who is running this, for the audit row\n\n" +
        "  e.g. --email vincent.koh@nus.edu.sg --from VKTJ66 \\\n" +
        "       --to EXT:VINCENT_KOH --actor E1633673",
    );
  }

  console.log(`  email:  ${JSON.stringify(EMAIL)}`);
  console.log(`  from:   ${JSON.stringify(FROM)}`);
  console.log(`  to:     ${JSON.stringify(TO)}`);
  console.log(`  actor:  ${JSON.stringify(ACTOR)}`);

  if (!isExtUserID(TO)) {
    refuse(
      "PIN_NOT_EXT",
      `--to ${JSON.stringify(TO)} does not match /^EXT:[A-Z0-9_]{3,32}$/. ` +
        `The namespace IS the mechanism: pinnedUserIDFor re-validates it at every ` +
        `read and returns the ABSENT identity for anything outside it, so this ` +
        `would move every row onto a key no session can ever resolve to.`,
    );
  }
  if (isExtUserID(FROM)) {
    refuse(
      "FROM_IS_EXT",
      `--from ${JSON.stringify(FROM)} is already an EXT pin. This script moves a ` +
        `LEGACY key onto a pin. Pin-to-pin is a different operation (the old pin's ` +
        `AuthAllowlist row would also have to move or be removed) and it is not ` +
        `implemented here.`,
    );
  }
  if (!FROM || FROM.trim() === "") {
    refuse(
      "FROM_IS_BLANK",
      `--from is empty. \`where: { userID: "" }\` is the sentinel bug class: it ` +
        `matches every ""-keyed row in the database, which are by definition not ` +
        `this account's.`,
    );
  }
  if (FROM === TO) {
    refuse("FROM_EQUALS_TO", `--from and --to are the same key. Nothing to move.`);
  }
  if (canonicalUserID(EMAIL) !== null) {
    refuse(
      "EMAIL_IS_CANONICAL",
      `${JSON.stringify(EMAIL)} derives a canonical identity of its own ` +
        `(${JSON.stringify(canonicalUserID(EMAIL))}), so it does not need a pin. ` +
        `Pinning it would give one human two identities — the same refusal ` +
        `admin.addAuthAllowlistEntry makes.`,
    );
  }

  if (refusals.length) return report();

  /* ---- 1. the AuthAllowlist collection and its indexes ------------------ */
  // M3 must exist before we create a row: without the unique indexes two
  // concurrent runs can both claim this pin. It also PROVES the collection
  // exists, which the transaction below depends on (Mongo will not implicitly
  // create a collection inside one).
  let indexNames = [];
  try {
    const r = await db.$runCommandRaw({ listIndexes: "AuthAllowlist" });
    indexNames = (r?.cursor?.firstBatch ?? []).map((i) => String(i.name));
  } catch {
    indexNames = [];
  }
  const haveIdx =
    indexNames.includes("email_unique") && indexNames.includes("pin_unique");
  console.log(
    `\n  AuthAllowlist indexes: ${indexNames.length ? indexNames.join(", ") : "(collection absent)"}`,
  );
  if (!haveIdx) {
    refuse(
      "ALLOWLIST_INDEXES_MISSING",
      `email_unique and/or pin_unique are not present. Mechanism M3 does not ` +
        `exist without them, and MongoDB will not create the collection ` +
        `implicitly inside the transaction below. Run ` +
        `\`node scripts/remediation/create-auth-allowlist.mjs --commit\` first.`,
    );
  }

  /* ---- 2. the User row -------------------------------------------------- */
  // EXPLICIT SELECT, never a bare findMany: #9 (passwordHash must not be read
  // into this process) and I-2 (Prisma 6 throws deserializing a row missing a
  // required non-list scalar). `passwordHash` is taken as a BOOLEAN-ish
  // presence check only, so its value never lands in a variable or a log.
  const usersByEmail = await db.user.findMany({
    where: { email: { equals: EMAIL, mode: "insensitive" } },
    select: { id: true, email: true, userID: true, displayName: true, block: true, telegramHandle: true },
  });
  console.log(`\n  User rows for this email: ${usersByEmail.length}`);
  for (const u of usersByEmail) {
    console.log(
      `    _id=${u.id}  userID=${JSON.stringify(u.userID)}  ` +
        `displayName=${JSON.stringify(u.displayName)}  block=${JSON.stringify(u.block)}  ` +
        `telegramHandle=${JSON.stringify(u.telegramHandle)}`,
    );
  }
  if (usersByEmail.length === 0) {
    refuse(
      "NO_USER_ROW",
      `no User row for ${JSON.stringify(EMAIL)}. This script only MOVES an existing ` +
        `account. To create one, use provision-ext-account.mjs.`,
    );
  }
  if (usersByEmail.length > 1) {
    refuse(
      "FROM_KEY_NOT_EXCLUSIVE",
      `${usersByEmail.length} User rows share this address. Merge them first ` +
        `(scripts/remediation/merge-by-canonical.mjs) — re-keying one of a pair ` +
        `leaves the other holding the old key.`,
    );
  }
  const userRow = usersByEmail[0] ?? null;

  // EXCLUSIVITY OF THE OLD KEY. `User.userID` has NO unique index (see M5 in
  // provision-ext-account.mjs), and this database really does contain rows whose
  // stored userID is a DIFFERENT LIVE HUMAN'S key — fix-claresta-duplicate.mjs
  // documents one. Every updateMany below is `where: { userID: FROM }`, so if a
  // second person carries FROM their rows come across too, filed under this
  // person's new pin, and nothing would ever report it.
  const usersByFromKey = await db.user.findMany({
    where: { userID: FROM },
    select: { id: true, email: true },
  });
  console.log(`  User rows carrying --from (${JSON.stringify(FROM)}): ${usersByFromKey.length}`);
  for (const u of usersByFromKey) console.log(`    _id=${u.id}  email=${JSON.stringify(u.email)}`);
  if (usersByFromKey.length > 1) {
    refuse(
      "FROM_KEY_NOT_EXCLUSIVE",
      `${usersByFromKey.length} User rows carry userID=${JSON.stringify(FROM)}. ` +
        `Re-keying by \`where: { userID }\` would carry the other account's rows ` +
        `across as well. Resolve the split identity first.`,
    );
  }

  /* ---- 3. the allowlist row (may already exist — resumability) ---------- */
  const pinByEmail = await db.authAllowlist.findUnique({ where: { email: EMAIL } });
  const pinByPin = await db.authAllowlist.findUnique({ where: { pinnedUserID: TO } });
  console.log(
    `\n  AuthAllowlist by email: ${pinByEmail ? JSON.stringify(pinByEmail.pinnedUserID) : "absent"}` +
      `   by pin: ${pinByPin ? JSON.stringify(pinByPin.email) : "absent"}`,
  );
  if (pinByEmail && pinByEmail.pinnedUserID !== TO) {
    refuse(
      "EMAIL_PINNED_ELSEWHERE",
      `${JSON.stringify(EMAIL)} is already pinned to ` +
        `${JSON.stringify(pinByEmail.pinnedUserID)}, not ${JSON.stringify(TO)}.`,
    );
  }
  if (pinByPin && normalizeEmail(pinByPin.email) !== EMAIL) {
    refuse(
      "PIN_PINNED_ELSEWHERE",
      `${JSON.stringify(TO)} is already pinned to ${JSON.stringify(pinByPin.email)}. ` +
        `Pins are not reusable.`,
    );
  }
  // OUR OWN row already being there is NOT a refusal — it is what a resumed or
  // re-checked run looks like. See ALREADY_MIGRATED below.
  const allowlistRowIsOurs = Boolean(pinByEmail && pinByEmail.pinnedUserID === TO);

  /* ---- 4. the census ---------------------------------------------------- */
  const ownership = [];
  for (const c of OWNERSHIP) {
    ownership.push({
      ...c,
      from: await countKey(c.model, c.field, FROM),
      to: await countKey(c.model, c.field, TO),
    });
  }
  const history = [];
  for (const c of HISTORY) {
    history.push({
      ...c,
      from: await countKey(c.model, c.field, FROM),
      to: await countKey(c.model, c.field, TO),
    });
  }
  const unresolved = [];
  for (const c of UNRESOLVED) {
    unresolved.push({
      ...c,
      from: await countKey(c.model, c.field, FROM, c.isArray),
      to: await countKey(c.model, c.field, TO, c.isArray),
    });
  }

  const W = 22;
  console.log(`\n--- [A] OWNERSHIP — these MOVE -------------------------------------`);
  console.log(`  ${pad("collection.field", W + 14)} ${padL("under FROM", 11)} ${padL("under TO", 9)}   note`);
  let totalMove = 0;
  for (const c of ownership) {
    totalMove += c.from;
    console.log(
      `  ${pad(`${c.model}.${c.field}`, W + 14)} ${padL(c.from, 11)} ${padL(c.to, 9)}   ` +
        `${c.unique ? "[unique] " : ""}${c.note}`,
    );
  }
  console.log(`  ${pad("User.userID (by _id)", W + 14)} ${padL(userRow?.userID === FROM ? 1 : 0, 11)} ${padL(userRow?.userID === TO ? 1 : 0, 9)}   the account row itself`);

  console.log(`\n--- [B] HISTORY — these DELIBERATELY STAY -------------------------`);
  console.log(`  RoleAuditLog is append-only by code contract and its rows state what`);
  console.log(`  was TRUE AT THE TIME. Re-keying them would make the log assert history`);
  console.log(`  that did not happen. The identity.rekey row written below is the JOIN`);
  console.log(`  between the two keys — query BOTH when auditing this account.`);
  console.log(`  ${pad("collection.field", W + 14)} ${padL("under FROM", 11)} ${padL("under TO", 9)}   note`);
  let totalStay = 0;
  for (const c of history) {
    totalStay += c.from;
    console.log(
      `  ${pad(`${c.model}.${c.field}`, W + 14)} ${padL(c.from, 11)} ${padL(c.to, 9)}   ${c.note}`,
    );
  }

  console.log(`\n--- [C] UNRESOLVED KEY FORMAT — non-zero STOPS the run -------------`);
  console.log(`  ${pad("collection.field", W + 14)} ${padL("under FROM", 11)} ${padL("under TO", 9)}   note`);
  for (const c of unresolved) {
    console.log(
      `  ${pad(`${c.model}.${c.field}`, W + 14)} ${padL(c.from, 11)} ${padL(c.to, 9)}   ${c.note}`,
    );
    if (c.from > 0) {
      refuse(
        "UNRESOLVED_DOMAIN_ROWS",
        `${c.model}.${c.field} has ${c.from} row(s) under ${JSON.stringify(FROM)}. ` +
          `userAdmin.ts records that nobody has established whether the supper ` +
          `domain uses this key format, and SupperGroup carries denormalized ` +
          `aggregates (numOrders, userIdList, totalPrice, currentFoodCost) that a ` +
          `partial move would leave disagreeing with the Orders they summarise. ` +
          `This script will not guess. Decide with the owner, then either move ` +
          `them by hand in the same transaction or accept leaving them.`,
      );
    }
  }

  /* ---- 5. TARGET_KEY_OCCUPIED ------------------------------------------ */
  // THE MOST IMPORTANT REFUSAL IN THIS FILE. Rows already under --to mean the
  // move would MERGE TWO IDENTITIES. The unique collections would abort the
  // transaction on their own, loudly; the non-unique ones (Bookings, Posts,
  // UserCCA, Gym, CcaApplication) would silently interleave two people's rows
  // under one key, with no error and no way to tell them apart afterwards.
  // Checked across ALL THREE buckets, because a stray history row under the
  // target key is equally a sign that this pin is not new.
  const occupied = [...ownership, ...history, ...unresolved].filter((c) => c.to > 0);
  const otherUserOnTo = await db.user.findMany({
    where: { userID: TO },
    select: { id: true, email: true },
  });
  const foreignUserOnTo = otherUserOnTo.filter((u) => u.id !== userRow?.id);
  if (foreignUserOnTo.length) {
    refuse(
      "TARGET_KEY_OCCUPIED",
      `${foreignUserOnTo.length} OTHER User row(s) already carry userID=${JSON.stringify(TO)}: ` +
        foreignUserOnTo.map((u) => JSON.stringify(u.email)).join(", ") +
        `. User.userID has no unique index, so nothing else would catch this.`,
    );
  }

  /* ---- 6. ALREADY MIGRATED? -------------------------------------------- */
  // A clean no-op, exit 0. Everything under --to and nothing under --from, with
  // our allowlist row in place, IS the finished state. Reporting it as a
  // refusal would send an operator who is merely re-checking their work off to
  // investigate a healthy system.
  const nothingLeftBehind = ownership.every((c) => c.from === 0);
  const alreadyMigrated =
    allowlistRowIsOurs && userRow?.userID === TO && nothingLeftBehind;
  if (alreadyMigrated && !refusals.length) {
    console.log(`\n=== ALREADY MIGRATED — nothing to do ===`);
    console.log(`  AuthAllowlist pins ${JSON.stringify(EMAIL)} -> ${JSON.stringify(TO)}`);
    console.log(`  User.userID is ${JSON.stringify(TO)}`);
    console.log(`  0 rows remain under ${JSON.stringify(FROM)} in every ownership collection.`);
    console.log(`  Exit 0. This is a no-op, not an error.\n`);
    return;
  }
  if (occupied.length && !alreadyMigrated) {
    for (const c of occupied) {
      refuse(
        "TARGET_KEY_OCCUPIED",
        `${c.model}.${c.field} already has ${c.to} row(s) under ${JSON.stringify(TO)} ` +
          `while ${c.from} remain under ${JSON.stringify(FROM)}. Moving now would MERGE ` +
          `two identities' rows under one key. Nothing has been written; resolve by hand.`,
      );
    }
  }

  if (userRow && userRow.userID !== FROM && userRow.userID !== TO) {
    refuse(
      "USER_KEY_MISMATCH",
      `the User row's stored userID is ${JSON.stringify(userRow.userID)}, not ` +
        `${JSON.stringify(FROM)}. Every count above was measured against --from, so ` +
        `they describe rows that may not belong to this account at all.`,
    );
  }

  if (refusals.length) return report();

  /* ---- 7. the plan ------------------------------------------------------ */
  console.log(`\n--- [D] PLAN -------------------------------------------------------`);
  console.log(`  1. AuthAllowlist  ${allowlistRowIsOurs ? "already present (kept)" : `create { email: ${JSON.stringify(EMAIL)}, pinnedUserID: ${JSON.stringify(TO)}, addedBy: ${JSON.stringify(ACTOR)} }`}`);
  console.log(`  2. User._id=${userRow?.id}  userID: ${JSON.stringify(userRow?.userID)} -> ${JSON.stringify(TO)}`);
  console.log(`     (email, passwordHash, displayName, bio, telegramHandle, block untouched —`);
  console.log(`      Prisma's update emits $set on the named field only, so fields this`);
  console.log(`      schema does not model, including whatever the User $jsonSchema`);
  console.log(`      validator requires, survive the write.)`);
  for (const c of ownership) {
    if (c.from > 0) console.log(`  3. ${pad(`${c.model}.${c.field}`, 32)} updateMany ${padL(c.from, 4)} row(s)`);
  }
  console.log(`  4. RoleAuditLog   create 1 row  action="identity.rekey"  targetUserID=${JSON.stringify(TO)}`);
  console.log(`                    rolesBefore=[${JSON.stringify(FROM)}]  rolesAfter=[${JSON.stringify(TO)}]`);
  console.log(`\n  TOTAL DOCUMENTS MOVED: ${totalMove + 1} (${totalMove} owned rows + the User row)`);
  console.log(`  TOTAL LEFT AS HISTORY: ${totalStay}  — see [B]; this is deliberate.`);

  if (!COMMIT) {
    console.log(`\n=== DRY RUN — nothing was written. Re-run with --commit to apply. ===`);
    console.log(
      `\n  After committing, the account signs in at its own address and its\n` +
        `  session resolves to ${JSON.stringify(TO)}. It holds NO ROLES until an admin\n` +
        `  grants them at /admin/users, and its bookings become visible again\n` +
        `  immediately because facilitiesBooking joins owner on User.userID.\n`,
    );
    return;
  }

  /* ---- 8. the write — ONE transaction ----------------------------------- */
  console.log(`\n--- [E] writing (one transaction) ----------------------------------`);
  const actorRow = await db.userRole
    .findUnique({ where: { userID: ACTOR }, select: { roles: true } })
    .catch(() => null);

  const moved = {};
  await db.$transaction(
    async (tx) => {
      if (!allowlistRowIsOurs) {
        await tx.authAllowlist.create({
          data: {
            email: EMAIL,
            pinnedUserID: TO,
            note: `re-keyed from legacy id ${FROM}`,
            addedBy: ACTOR,
          },
        });
      }

      // The User row BY _id, never `where: { userID: FROM }` — that column is
      // not unique and FROM_KEY_NOT_EXCLUSIVE above is a pre-check, not an
      // index. The explicit `select` keeps this off passwordHash (#9, I-2).
      await tx.user.update({
        where: { id: userRow.id },
        data: { userID: TO },
        select: { id: true, userID: true },
      });

      for (const c of ownership) {
        if (c.from === 0) {
          moved[`${c.model}.${c.field}`] = 0;
          continue;
        }
        const r = await tx[c.model].updateMany({
          where: { [c.field]: FROM },
          data: { [c.field]: TO },
        });
        moved[`${c.model}.${c.field}`] = r.count;
      }

      // INSIDE the transaction, deliberately diverging from writeAudit's
      // "audit outside, so an audit failure cannot undo the act" posture — the
      // same trade provision-ext-account.mjs makes and for the same reason.
      // This run is atomic and re-runnable, so a rollback costs nothing, and it
      // is the only way "the identity moved" and "there is a record of it"
      // cannot come apart. That matters more here than anywhere else in this
      // codebase: this row is the ONLY link between the two halves of a
      // split audit trail (see [B]).
      await tx.roleAuditLog.create({
        data: {
          actorUserID: ACTOR,
          actorRoles: actorRow?.roles ?? [],
          targetUserID: TO,
          targetFacilityID: null,
          targetCcaID: null,
          targetEventID: null,
          action: "identity.rekey",
          rolesBefore: [FROM],
          rolesAfter: [TO],
          reason: EMAIL,
          ok: true,
          denyReason: null,
          batchId: null,
        },
      });
    },
    // Raised from Prisma's 5s default. The operation count is small (~15
    // commands regardless of document count — 68 bookings move in ONE
    // updateMany), but a cold Atlas connection plus a transaction commit on a
    // replica set is worth the headroom, and a timeout here rolls the whole
    // thing back rather than half-applying it.
    { timeout: 120_000, maxWait: 15_000 },
  );

  for (const [k, v] of Object.entries(moved)) {
    if (v > 0) console.log(`  moved ${padL(v, 4)}  ${k}`);
  }
  console.log(`  User row re-keyed.`);

  /* ---- 9. verify by RE-READ -------------------------------------------- */
  // The transaction returning is not proof. Re-read from the cluster: zero left
  // behind, and the counts we expected now under the new key.
  console.log(`\n--- [F] verification (re-read) -------------------------------------`);
  let bad = 0;
  for (const c of ownership) {
    const left = await countKey(c.model, c.field, FROM);
    const now = await countKey(c.model, c.field, TO);
    const ok = left === 0 && now === c.from + c.to;
    if (!ok) bad++;
    console.log(
      `  ${ok ? "OK  " : "BAD "} ${pad(`${c.model}.${c.field}`, W + 14)} ` +
        `left under FROM=${padL(left, 4)}  under TO=${padL(now, 4)} (expected ${c.from + c.to})`,
    );
  }
  const finalUser = await db.user.findUnique({
    where: { id: userRow.id },
    select: { id: true, email: true, userID: true, displayName: true, block: true, telegramHandle: true },
  });
  const userOk = finalUser?.userID === TO;
  if (!userOk) bad++;
  console.log(`  ${userOk ? "OK  " : "BAD "} User._id=${userRow.id} userID=${JSON.stringify(finalUser?.userID)}`);
  console.log(
    `       preserved: email=${JSON.stringify(finalUser?.email)} ` +
      `displayName=${JSON.stringify(finalUser?.displayName)} ` +
      `block=${JSON.stringify(finalUser?.block)} ` +
      `telegramHandle=${JSON.stringify(finalUser?.telegramHandle)}`,
  );
  const finalPin = await db.authAllowlist.findUnique({ where: { pinnedUserID: TO } });
  const pinOk = finalPin && normalizeEmail(finalPin.email) === EMAIL;
  if (!pinOk) bad++;
  console.log(`  ${pinOk ? "OK  " : "BAD "} AuthAllowlist ${JSON.stringify(TO)} -> ${JSON.stringify(finalPin?.email)}`);

  if (bad) {
    return abort(
      `${bad} verification failure(s). The transaction reported success, so the ` +
        `cluster and this read disagree — do NOT re-run blindly. Inspect by hand.`,
    );
  }
  console.log(`\n=== DONE. Re-running this command is now a clean no-op. ===`);
  console.log(
    `  NEXT: the account still holds NO ROLES. Grant them at /admin/users ->\n` +
      `  Manage roles (the row is now keyed ${JSON.stringify(TO)} and the Manage button\n` +
      `  is enabled). Their ${totalMove} moved row(s) are visible to them immediately.\n`,
  );
}

function report() {
  console.error(`\n*** ${refusals.length} REFUSAL(S) — NOTHING WAS WRITTEN ***\n`);
  for (const r of refusals) console.error(`  [${r.code}] ${r.why}\n`);
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    abort(
      `unhandled failure. If it happened during [E], the transaction rolled back ` +
        `and NOTHING was written — re-run the dry run to confirm, then re-run with ` +
        `--commit.`,
    );
  })
  .finally(() => db.$disconnect());
