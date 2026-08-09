/**
 * Provisions ONE admin-pinned external account: an `AuthAllowlist` row, the
 * `User` row that goes with it, and one `authAllowlist.add` audit row.
 *
 *   node scripts/remediation/provision-ext-account.mjs \
 *     --email ngocanh.mai@nus.edu.sg --name "Mai Ngoc Anh" \
 *     --pin EXT:NGOCANH_MAI --actor E1633673
 *   ... add --commit to actually write.
 *   ... add --print-reset-link to also mint a password-reset URL.
 *
 * Dry run by default. It prints the exact three documents it would write and
 * every refusal it evaluated, then stops.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN "EXT" ACCOUNT IS, AND WHY IT IS DANGEROUS
 * ---------------------------------------------------------------------------
 *
 * Whatever string lands in `session.user.userID` IS the authorization key.
 * `auth.ts` does a bare `db.userRole.findUnique({ where: { userID } })` and
 * `access.ts`'s `getUserRoles` does the same; neither checks provenance. So a
 * row `{ email: "attacker@gmail.com", pinnedUserID: "E1633673" }` would hand an
 * attacker an admin's roles with NO grant path — meaning no escalation guard
 * anywhere would fire, because none was crossed.
 *
 * Four mechanisms make that unrepresentable rather than merely refused:
 *   M1  `canonicalUserID`'s capture class is [A-Z0-9._%-]. It does not contain
 *       ':'. `EXT_ID` requires one. The two key spaces are PROVABLY DISJOINT,
 *       so a pin can never equal a NUSNET id for any input. "E1633673" fails
 *       EXT_ID; that is refusal PIN_NOT_EXT below.
 *   M2  `asExtUserID` re-validates the pin AT EVERY READ in
 *       services/authAllowlist.ts, so a row hand-written in Atlas mints NO
 *       identity at all.
 *   M3  `pinnedUserID` unique, enforced by a real Mongo index built by
 *       create-auth-allowlist.mjs. A Prisma @unique alone enforces nothing.
 *   M4  the write path is adminProcedure + audited + refuses three shapes.
 *
 * THIS SCRIPT IS A FIFTH WRITE PATH INTO THAT COLLECTION, so it reproduces M4's
 * refusals itself rather than inheriting them. Read the refusal list below as
 * the security surface it is.
 *
 * ---------------------------------------------------------------------------
 * REFUSALS — every one exits 1 and writes NOTHING
 * ---------------------------------------------------------------------------
 *
 *  EMAIL_IS_CANONICAL       `canonicalUserID(email)` is non-null, i.e. the
 *                           address is an @u.nus.edu one that ALREADY has an
 *                           identity. Pinning it would give one human two
 *                           identity keys — two role rows, two booking owners,
 *                           two audit trails, and a permanent split-brain that
 *                           no merge script can cleanly undo.
 *  PIN_NOT_EXT              the pin fails EXT_ID. This is M1 at the write side.
 *                           Without it the script IS the attack.
 *  USER_ALREADY_EXISTS      a `User` row already exists for that address
 *                           (case-insensitively — `email_unique_ci` folds case
 *                           but NOT whitespace). Creating a second row makes a
 *                           duplicate account, which is the class this repo has
 *                           already had to remediate by hand.
 *  PIN_ALREADY_HAS_ROLES    a `UserRole` row already exists under this pin.
 *                           Defence in depth behind M3: refuses aiming a key
 *                           that ALREADY CARRIES PRIVILEGE at a new address,
 *                           even if the unique index were somehow absent.
 *  PIN_ALREADY_ON_USER_ROW  a `User` row ALREADY CARRIES this pin in `userID`,
 *                           under a DIFFERENT email. THERE IS NO DATABASE
 *                           GUARD FOR THIS: `User.userID` has no `@unique` in
 *                           schema.prisma and no index behind it, so
 *                           `db.user.create` would cheerfully make a second row
 *                           on the same identity key. Two `User` rows sharing
 *                           one key makes facilitiesBooking.ts's booking->owner
 *                           join (`where: { userID: booking.userID }`)
 *                           AMBIGUOUS — whichever row Mongo returns first names
 *                           the owner — and makes `admin.listUsers`'
 *                           `keyMismatch` meaningless for the pair. Every one of
 *                           the other refusals passes in this state, so without
 *                           this one the script writes the duplicate.
 *  EMAIL_ALREADY_PINNED     the address is already in `AuthAllowlist`.
 *  PIN_ALREADY_USED         the pin is already in `AuthAllowlist`.
 *  ALLOWLIST_UNREADABLE     the collection could not be read. FAIL CLOSED — an
 *                           unreadable allowlist must never be treated as an
 *                           empty one, or the two refusals above evaporate.
 *  ALLOWLIST_INDEXES_MISSING (--commit only) `pin_unique` / `email_unique` are
 *                           not built, so M3 does not exist and the two
 *                           refusals above are the ONLY thing preventing a
 *                           duplicate pin — a check-then-write with a race in
 *                           it. Run create-auth-allowlist.mjs first. Reported
 *                           as a WARNING in a dry run so a preview still works
 *                           before that step of the rollout.
 *  BAD_ACTOR                --actor is missing or is not a well-shaped
 *                           identity key. It is written to
 *                           `RoleAuditLog.actorUserID`; an audit row naming
 *                           nobody is not an audit row.
 *
 * ---------------------------------------------------------------------------
 * THE `User` ROW — every field is a decision
 * ---------------------------------------------------------------------------
 *
 *  email        normalizeEmail'd (trimmed, lowercased). Must match
 *               AuthAllowlist.email BYTE FOR BYTE — `email_unique_ci` is
 *               collation strength 2, which folds CASE but not WHITESPACE.
 *  displayName  SET AT CREATION, and load-bearing: it is the only profile field
 *               the strict always-on profile gate will still demand of an
 *               `scrc` holder, so setting it here means the forced dialog never
 *               opens for them.
 *  userID       the pin. Three consequences, and the third is the real reason:
 *               it matches register/route.ts's pattern; it makes `keyMismatch`
 *               false so a future delete is not blocked by LEGACY_KEY_MISMATCH;
 *               and facilitiesBooking.ts joins booking -> owner on
 *               `where: { userID: booking.userID }`, so WITHOUT IT every hall
 *               office booking renders with a blank owner name.
 *  passwordHash OMITTED (null) ON PURPOSE. `auth.ts`'s credentials `authorize`
 *               does `if (!user?.passwordHash) return null`, so this account
 *               CANNOT BE LOGGED INTO until a password is set. The password
 *               reset flow is the only way in, which is exactly the intended
 *               provisioning path — an admin never types someone's password.
 *  block, telegramHandle, bio   OMITTED. A hall office staff member has no hall
 *               block to live in and no reason to publish a Telegram handle to
 *               residents. (There is no `matric` field on `User` at all; matric
 *               lives in its own collection and none is written.)
 *  createdAt    left to @default(now()).
 *
 * PRISMA'S TYPED `create` IS USED FOR THE `User` INSERT, NOT $runCommandRaw,
 * AND THAT IS NOT A STYLE CHOICE. The `User` collection carries a DB-level
 * `$jsonSchema` validator. A validator rejection is error code 121, and
 * `$runCommandRaw` returns it as DATA — `{ ok: 1, writeErrors: [{ code: 121 }] }`
 * — rather than throwing. A raw insert would therefore report SUCCESS on a row
 * that does not exist, and the operator would move on to granting roles to an
 * account that was never created. Prisma's typed `create` THROWS. Run
 * preflight-scrc-validators.mjs first to see the validator before you find out
 * this way.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT: A FAILED RUN LEAVES THE CLUSTER RE-RUNNABLE
 * ---------------------------------------------------------------------------
 *
 * After any failure of this script, RE-RUNNING THE SAME COMMAND SUCCEEDS. That
 * is a property of the write path, not an aspiration, and it is stated here
 * because the previous shape did not have it and the cost was hidden.
 *
 * WHAT THE PREVIOUS SHAPE COST. The three documents were three separate
 * un-transacted creates. An `AuthAllowlist` row that landed followed by a `User`
 * create that threw left an ORPHAN PIN — and a re-run then trips BOTH
 * `EMAIL_ALREADY_PINNED` and `PIN_ALREADY_USED` and refuses. There is no script
 * in this repository that deletes an `AuthAllowlist` row; the only remover is
 * `admin.removeAuthAllowlistEntry` on the tRPC surface. So the operator
 * discovered, mid-provisioning, that the documented next step was hand surgery.
 *
 * WHAT IT IS NOW: ONE `db.$transaction([...])` carrying all three creates.
 * Mongo aborts the whole transaction on any failure, so the three documents
 * appear together or not at all, and "not at all" is precisely the state a
 * re-run wants.
 *
 *   - THE ARRAY FORM, not the interactive callback. It issues the three writes
 *     sequentially in one transaction and, critically, still THROWS on failure
 *     — so the P2002 and code-121 handling below stays meaningful rather than
 *     becoming a branch that can no longer be reached.
 *   - ORDER INSIDE THE ARRAY IS STILL AuthAllowlist, User, audit. The allowlist
 *     row is the one protected by a UNIQUE INDEX, and writing it first means a
 *     concurrent run conflicts on the index at the earliest possible moment
 *     rather than after a `User` row exists.
 *   - MONGO WILL NOT IMPLICITLY CREATE A COLLECTION INSIDE A TRANSACTION. All
 *     three collections must therefore already exist. `User` and `RoleAuditLog`
 *     have existed since phase 1; `AuthAllowlist` is created by
 *     create-auth-allowlist.mjs, which the rollout order guarantees has run
 *     (step 19 precedes step 20) — and which the `ALLOWLIST_INDEXES_MISSING`
 *     refusal below independently PROVES under --commit, since `listIndexes`
 *     cannot report both unique indexes on a collection that does not exist.
 *   - THE AUDIT ROW IS INSIDE THE TRANSACTION, which DIVERGES DELIBERATELY from
 *     `writeAudit`'s posture in routers/admin.ts ("the audit write must not undo
 *     the act"). That posture is right for a user-facing mutation, where undoing
 *     is worse than an unaudited act. It is wrong here: this script is re-runnable
 *     by construction, so rolling back and letting the operator run the same
 *     command again costs nothing — and it is the only way "provisioned" and
 *     "audited" cannot come apart. An unaudited provisioning is exactly the
 *     untraceable state the audit row exists to prevent.
 *
 * BELT AND BRACES, because the transaction has a PREREQUISITE (a replica set —
 * Atlas is one — and the three collections existing). If the transaction throws,
 * the catch RE-READS the cluster and, if it finds the allowlist row present with
 * no `User` row, DELETES the orphan it just created. If that compensating delete
 * also fails, it prints the exact recovery command rather than the word
 * "cleaned up". See section 7.
 *
 * ---------------------------------------------------------------------------
 * --print-reset-link
 * ---------------------------------------------------------------------------
 *
 * Mints a `PasswordResetSession` directly and prints the URL, mirroring
 * src/app/api/reset-password/request-verification-code/route.ts exactly: a
 * 32-byte hex token, a 15-MINUTE TTL, and prior outstanding tokens for that
 * address deleted first. It exists because `sendPasswordResetEmail` goes out
 * through Resend from noreply@rhapp.lol, and NUS staff mail may spam-file or
 * reject that sender — in which case the account is a dead end (no
 * passwordHash, no way to set one) until someone hands over a link out of band.
 *
 * If the account is ALREADY provisioned — an AuthAllowlist row exists pinning
 * EXACTLY this email to EXACTLY this pin, and the User row exists — then
 * --print-reset-link puts the script into LINK-ONLY mode: it provisions
 * nothing and only mints the token. That is the documented recovery path.
 * The exact-pair requirement is what stops this being a general-purpose "mint
 * a password reset for any address" tool.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import {
  canonicalUserID,
  normalizeEmail,
  isCanonicalResidentID,
  isExtUserID,
  EXT_ID,
} from "./lib/identity.mjs";
import { isCommit, banner, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const COMMIT = isCommit();
const PRINT_LINK = process.argv.includes("--print-reset-link");

/** `--flag value`. Same shape as inventory-rbac.mjs / restore-legacy-scalars.mjs. */
function argOf(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
}

const RAW_EMAIL = argOf("--email");
const RAW_NAME = argOf("--name");
const RAW_PIN = argOf("--pin");
const RAW_ACTOR = argOf("--actor");

/** Same transform the server's zod schema applies (.trim().toUpperCase()), so a
 *  pin typed here and a pin typed in the admin UI cannot diverge. */
const PIN = RAW_PIN === null ? null : RAW_PIN.trim().toUpperCase();
const EMAIL = RAW_EMAIL === null ? null : normalizeEmail(RAW_EMAIL);
const NAME = RAW_NAME === null ? null : RAW_NAME.trim();
const ACTOR = RAW_ACTOR === null ? null : RAW_ACTOR.trim();

const TOKEN_TTL_MS = 15 * 60 * 1000;

const refusals = [];
const refuse = (code, why) => refusals.push({ code, why });

const USAGE =
  `usage: node scripts/remediation/provision-ext-account.mjs \\\n` +
  `         --email <address> --name "<display name>" --pin EXT:<SLUG> --actor <userID> \\\n` +
  `         [--commit] [--print-reset-link]`;

async function main() {
  banner("provision-ext-account.mjs", COMMIT);

  // -- 0. arguments ---------------------------------------------------------
  if (!RAW_EMAIL || !RAW_NAME || !RAW_PIN || !RAW_ACTOR) {
    console.log(USAGE);
    return abort(`--email, --name, --pin and --actor are all required.`);
  }
  console.log(`  email  : ${JSON.stringify(EMAIL)}   (normalizeEmail'd from ${JSON.stringify(RAW_EMAIL)})`);
  console.log(`  name   : ${JSON.stringify(NAME)}`);
  console.log(`  pin    : ${JSON.stringify(PIN)}`);
  console.log(`  actor  : ${JSON.stringify(ACTOR)}`);
  console.log(`  link   : ${PRINT_LINK ? "yes (--print-reset-link)" : "no"}`);

  if (!NAME) {
    refuse("EMPTY_NAME", `--name is blank after trimming. displayName is the ONE profile field an scrc holder must have; without it the forced profile dialog opens on their first request.`);
  }

  // -- 1. refusals that need no database ------------------------------------
  //
  // EMAIL_IS_CANONICAL. Written as a null test, never against a string literal:
  // the absent canonical id is null, and a `=== ""` form here would be VACUOUS
  // rather than wrong — it would match nothing, this refusal would never fire,
  // and the script would happily mint a second identity for a real student.
  const cid = canonicalUserID(EMAIL);
  if (cid !== null) {
    refuse(
      "EMAIL_IS_CANONICAL",
      `${JSON.stringify(EMAIL)} already canonicalises to ${JSON.stringify(cid)} — it is an ` +
        `@u.nus.edu address and therefore ALREADY has an identity. Pinning it would give ` +
        `one human two identity keys. This account does not need provisioning; it needs ` +
        `a role grant through /admin/users.`,
    );
  }

  // PIN_NOT_EXT. M1 at the write side. "E1633673" fails here, which is the
  // whole attack from 05-verification.md refused in one line.
  if (!isExtUserID(PIN)) {
    refuse(
      "PIN_NOT_EXT",
      `${JSON.stringify(PIN)} does not match ${String(EXT_ID)}. The ':' is the mechanism: ` +
        `canonicalUserID's capture class excludes it, so an EXT id can never collide with a ` +
        `NUSNET id. A pin outside this namespace mints NO identity at read time (M2) and, ` +
        `if it happened to BE a NUSNET id, would hand this address that person's roles.`,
    );
  }

  // BAD_ACTOR. isCanonicalResidentID is a SHAPE test (non-empty, no '@') — the
  // right predicate here precisely because it is not an E-format test: L-27,
  // "G.S_SAMUEL" is a real admin-capable id and refusing it would be the same
  // mistake as gating eligibility on /^E\d{7}$/. It also accepts an EXT pin.
  if (!isCanonicalResidentID(ACTOR)) {
    refuse(
      "BAD_ACTOR",
      `--actor ${JSON.stringify(ACTOR)} is not a well-shaped identity key. It is written ` +
        `verbatim to RoleAuditLog.actorUserID and to AuthAllowlist.addedBy; an audit row ` +
        `that names nobody is not an audit row. Pass the id of the human running this.`,
    );
  }

  // -- 2. state of the world (all reads) ------------------------------------
  console.log(`\n--- [1] current state ---`);

  // Case-insensitive, because `email_unique_ci` is collation strength 2: two
  // rows differing only in case are the SAME account to the index, and creating
  // the second one fails with E11000 (or, if the index has been dropped,
  // succeeds and makes a duplicate — which is worse).
  const existingUser = await db.user.findFirst({
    where: { email: { equals: EMAIL, mode: "insensitive" } },
    select: { id: true, email: true, userID: true, displayName: true, passwordHash: true },
  });
  console.log(
    `  User row for this email:      ` +
      (existingUser
        ? `PRESENT  userID=${JSON.stringify(existingUser.userID)} displayName=${JSON.stringify(existingUser.displayName)} passwordHash=${existingUser.passwordHash ? "set" : "(none)"}`
        : `absent`),
  );

  // THE PIN, AGAINST `User.userID` — the check with NO DATABASE GUARD BEHIND IT.
  //
  // `User.userID` carries no `@unique` in schema.prisma and no index in the
  // cluster, so unlike the pin checks against UserRole (@unique on userID) and
  // AuthAllowlist (pin_unique, M3), nothing stops `db.user.create` writing a
  // SECOND row on a key some other row already holds. A pre-existing `User` row
  // carrying this pin under a different address passes every other refusal in
  // this file.
  //
  // findFirst, not findUnique: findUnique needs a unique constraint the Prisma
  // schema does not declare, so it will not compile against this field — which
  // is itself the tell that the database is not enforcing anything here.
  const existingUserByPin = PIN
    ? await db.user.findFirst({
        where: { userID: PIN },
        select: { id: true, email: true, userID: true, displayName: true },
      })
    : null;
  console.log(
    `  User row carrying this pin:   ` +
      (existingUserByPin
        ? `PRESENT  email=${JSON.stringify(existingUserByPin.email)} displayName=${JSON.stringify(existingUserByPin.displayName)}`
        : `absent`) +
      `   (User.userID has NO unique index — this check is the only guard)`,
  );

  const existingRole = PIN
    ? await db.userRole.findUnique({ where: { userID: PIN }, select: { userID: true, roles: true } })
    : null;
  console.log(
    `  UserRole row for this pin:    ` +
      (existingRole ? `PRESENT  roles=${JSON.stringify(existingRole.roles)}` : `absent`),
  );

  // FAIL CLOSED on an unreadable allowlist. An error here must never read as
  // "no row" — that would silently disable EMAIL_ALREADY_PINNED and
  // PIN_ALREADY_USED, which are the two refusals standing between this script
  // and a duplicate pin.
  let byEmail = null;
  let byPin = null;
  let allowlistReadable = true;
  try {
    byEmail = await db.authAllowlist.findUnique({ where: { email: EMAIL } });
    byPin = PIN ? await db.authAllowlist.findUnique({ where: { pinnedUserID: PIN } }) : null;
  } catch (e) {
    allowlistReadable = false;
    refuse(
      "ALLOWLIST_UNREADABLE",
      `could not read AuthAllowlist: ${String(e?.message ?? e)}. Refusing to treat an ` +
        `unreadable allowlist as an empty one. If db.authAllowlist does not exist on the ` +
        `client, run \`npx prisma generate\` (NOT \`prisma db push\` — it drops ` +
        `User.email_unique_ci).`,
    );
  }
  if (allowlistReadable) {
    console.log(
      `  AuthAllowlist row for email:  ` +
        (byEmail ? `PRESENT  pinnedUserID=${JSON.stringify(byEmail.pinnedUserID)}` : `absent`),
    );
    console.log(
      `  AuthAllowlist row for pin:    ` +
        (byPin ? `PRESENT  email=${JSON.stringify(byPin.email)}` : `absent`),
    );
  }

  // M3's index, checked rather than assumed (risk R3: someone ships the model
  // and skips create-auth-allowlist.mjs; the @unique then enforces nothing and
  // the duplicate refusals below become a check-then-write with a race in it).
  let indexesOk = false;
  let indexNames = [];
  try {
    const li = await db.$runCommandRaw({ listIndexes: "AuthAllowlist" });
    indexNames = (li?.cursor?.firstBatch ?? [])
      .filter((i) => i?.unique === true)
      .map((i) => String(i?.name ?? ""));
    indexesOk = indexNames.includes("email_unique") && indexNames.includes("pin_unique");
  } catch {
    indexesOk = false; // collection absent, or unreadable — either way, not built
  }
  console.log(`  AuthAllowlist unique idx:     ${indexesOk ? "email_unique + pin_unique OK" : `MISSING  (found: ${indexNames.join(", ") || "none"})`}`);

  // -- 3. LINK-ONLY mode ----------------------------------------------------
  //
  // The documented recovery path when the reset email cannot be delivered. It
  // requires the EXACT pair to exist already — this address pinned to this pin,
  // plus the User row — so it cannot be used to mint a reset link for an
  // arbitrary account. Anything short of an exact match falls through to the
  // normal refusals.
  const exactPair =
    allowlistReadable &&
    !!byEmail &&
    !!byPin &&
    byEmail.pinnedUserID === PIN &&
    byPin.email === EMAIL;
  const LINK_ONLY = PRINT_LINK && exactPair && !!existingUser;

  if (LINK_ONLY) {
    console.log(`\n--- [2] LINK-ONLY mode ---`);
    console.log(
      `  This account is ALREADY provisioned: the AuthAllowlist row pins exactly this\n` +
        `  address to exactly this pin, and the User row exists. Nothing will be\n` +
        `  provisioned. Only a password-reset token is minted.`,
    );
    if (existingUser.passwordHash) {
      console.log(
        `  NOTE: this account already HAS a password. The link below will let whoever\n` +
          `  holds it replace that password. Only hand it to the account owner.`,
      );
    }
    // Every argument-level refusal still applies here. Only the four
    // already-exists refusals are expected in this mode, and those are
    // evaluated further down, after this branch returns. A malformed pin that
    // somehow reached the collection by hand must not be handed a login path —
    // M2 would refuse to mint an identity from it at read time anyway, so the
    // link would be a dead end that looks like a working one.
    if (refusals.length) {
      for (const r of refusals) console.error(`  REFUSED  ${r.code}: ${r.why}`);
      return abort(`the existing pair is malformed. Fix the AuthAllowlist row first.`);
    }
    return mintResetLink();
  }

  // -- 4. refusals that needed the database ---------------------------------
  if (existingUser) {
    refuse(
      "USER_ALREADY_EXISTS",
      `a User row already exists for ${JSON.stringify(existingUser.email)} ` +
        `(matched case-insensitively). Creating a second one makes a DUPLICATE ACCOUNT — ` +
        `the exact class this repo has already had to remediate by hand. If this is the ` +
        `account you meant to provision, it needs an AuthAllowlist row and a role grant, ` +
        `not a new User row.`,
    );
  }
  // PIN_ALREADY_ON_USER_ROW. Only when it is a DIFFERENT document from the one
  // USER_ALREADY_EXISTS is already reporting: if the same row matches both the
  // email and the pin, that refusal has already said everything true about it,
  // and a second entry saying it again would read as two problems.
  if (existingUserByPin && existingUserByPin.id !== existingUser?.id) {
    refuse(
      "PIN_ALREADY_ON_USER_ROW",
      `a User row already carries userID=${JSON.stringify(PIN)} under ` +
        `${JSON.stringify(existingUserByPin.email)}, which is not the address being ` +
        `provisioned. NOTHING IN THE DATABASE WOULD STOP THIS: User.userID has no ` +
        `@unique in schema.prisma and no index, so db.user.create would succeed and ` +
        `leave TWO User rows on one identity key. facilitiesBooking.ts joins ` +
        `booking -> owner with \`where: { userID: booking.userID }\`, so every hall ` +
        `office booking would then render whichever of the two rows came back first, ` +
        `and admin.listUsers' keyMismatch becomes meaningless for the pair. Choose a ` +
        `different pin, or resolve that row first.`,
    );
  }
  if (existingRole) {
    refuse(
      "PIN_ALREADY_HAS_ROLES",
      `a UserRole row already exists under ${JSON.stringify(PIN)} carrying ` +
        `${JSON.stringify(existingRole.roles)}. Pinning a NEW address to a key that ` +
        `already carries privilege is the re-aiming attack. Revoke those roles through ` +
        `the audited role path first, or choose a different pin.`,
    );
  }
  if (byEmail) {
    refuse(
      "EMAIL_ALREADY_PINNED",
      `${JSON.stringify(EMAIL)} is already pinned to ${JSON.stringify(byEmail.pinnedUserID)}. ` +
        `A pin is immutable by design: changing which key an address owns is remove-then-add, ` +
        `two audit rows, through the admin surface.`,
    );
  }
  if (byPin) {
    refuse(
      "PIN_ALREADY_USED",
      `${JSON.stringify(PIN)} is already pinned to ${JSON.stringify(byPin.email)}. Two ` +
        `addresses sharing one pin means two humans sharing one identity key, one role row ` +
        `and one audit trail.`,
    );
  }
  if (!indexesOk) {
    if (COMMIT) {
      refuse(
        "ALLOWLIST_INDEXES_MISSING",
        `AuthAllowlist's unique indexes are not built, so M3 does not exist: the Prisma ` +
          `@unique enforces NOTHING at runtime and the two refusals above are a ` +
          `check-then-write with a race in it. Run ` +
          `\`node scripts/remediation/create-auth-allowlist.mjs --commit\` first.`,
      );
    } else {
      console.log(
        `\n  WARNING: AuthAllowlist's unique indexes are not built. This is fine for a dry\n` +
          `  run, but --commit will REFUSE until create-auth-allowlist.mjs has run.`,
      );
    }
  }

  // -- 5. verdict -----------------------------------------------------------
  if (refusals.length) {
    console.error(`\n--- REFUSED (${refusals.length}) ---`);
    for (const r of refusals) console.error(`  ${r.code}\n      ${r.why}\n`);
    return abort(`nothing was written. Resolve every refusal above and re-run.`);
  }

  // -- 6. the plan ----------------------------------------------------------
  const allowlistDoc = {
    email: EMAIL,
    pinnedUserID: PIN,
    note: `provisioned by scripts/remediation/provision-ext-account.mjs`,
    addedBy: ACTOR,
  };
  // OMISSIONS ARE THE POINT — see the header. passwordHash absent forces the
  // reset flow; block / telegramHandle / bio absent is requirement 2.
  const userDoc = { email: EMAIL, displayName: NAME, userID: PIN };

  console.log(`\n--- [2] documents to write — ALL THREE IN ONE TRANSACTION ---`);
  console.log(`  1. AuthAllowlist  ${JSON.stringify(allowlistDoc)}`);
  console.log(`  2. User           ${JSON.stringify(userDoc)}`);
  console.log(`     (passwordHash, block, telegramHandle and bio are DELIBERATELY OMITTED)`);
  console.log(`  3. RoleAuditLog   action="authAllowlist.add" targetUserID=${JSON.stringify(PIN)} reason=${JSON.stringify(EMAIL)}`);
  console.log(
    `  They land together or not at all (db.$transaction), so a failure cannot leave\n` +
      `  an orphan pin that makes a re-run refuse. See the header.`,
  );

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing was written. Re-run with --commit to apply.`);
    console.log(
      `AFTERWARDS the account still CANNOT sign in: it has no passwordHash, and\n` +
        `auth.ts's authorize refuses on that. The reset flow is the only way in — either\n` +
        `the Forgot-password form, or --print-reset-link if mail cannot be delivered.\n` +
        `It also holds NO ROLES until an admin grants them through /admin/users.`,
    );
    return;
  }

  // -- 7. write -------------------------------------------------------------
  console.log(`\n--- [3] writing ---`);

  // actorRoles is read BEFORE the transaction opens, and from the database
  // rather than invented: the column means "the actor's roles AT THE TIME", and
  // a script that stamps ["admin"] on faith records a claim instead of a fact.
  // Outside the transaction because it is a READ that must not consume the
  // transaction's time budget, and because its failure mode is "no row", which
  // is a legitimate value here rather than an abort.
  const actorRow = await db.userRole
    .findUnique({ where: { userID: ACTOR }, select: { roles: true } })
    .catch(() => null);

  // ALL THREE DOCUMENTS, ONE TRANSACTION. See the header's invariant section:
  // the array form issues them in order and THROWS on failure, so the P2002 and
  // code-121 handling below is still live, while Mongo's abort is what makes a
  // failed run re-runnable instead of leaving an orphan pin no script can
  // delete.
  //
  // Ordered AuthAllowlist -> User -> audit. The allowlist row carries the unique
  // index (M3), so writing it first surfaces a concurrent claim on the pin at
  // the earliest possible moment.
  //
  // TYPED creates throughout, never $runCommandRaw — `User` carries a
  // $jsonSchema validator and a 121 rejection comes back from a raw command as
  // DATA (`{ok:1, writeErrors:[{code:121}]}`), so a raw insert would print
  // success over a row that does not exist. These throw.
  //
  // The audit row is field-for-field identical to writeAudit() in
  // src/server/api/routers/admin.ts, INCLUDING the fields it sets to null, so a
  // row written by this script and a row written by the admin surface are
  // indistinguishable to every reader of RoleAuditLog.
  let created;
  let userRow;
  try {
    [created, userRow] = await db.$transaction([
      db.authAllowlist.create({ data: allowlistDoc }),
      db.user.create({ data: userDoc }),
      db.roleAuditLog.create({
        data: {
          actorUserID: ACTOR,
          actorRoles: actorRow?.roles ?? [],
          targetUserID: PIN,
          targetFacilityID: null,
          targetCcaID: null,
          targetEventID: null,
          action: "authAllowlist.add",
          rolesBefore: [],
          rolesAfter: [],
          reason: EMAIL,
          ok: true,
          denyReason: null,
          batchId: null,
        },
      }),
    ]);
  } catch (e) {
    console.error(e);
    if (e?.code === "P2002") {
      console.error(
        `\n  AuthAllowlist unique violation (P2002 on ${JSON.stringify(e?.meta?.target ?? "?")}) — ` +
          `something\n  claimed this email or pin between the check and the write. That is M3 ` +
          `doing\n  its job.`,
      );
    }
    console.error(
      `\n  If this was error code 121, the User $jsonSchema rejected the document — run\n` +
        `  \`node scripts/remediation/preflight-scrc-validators.mjs\` to see which field.`,
    );
    return await recoverFromFailedWrite();
  }
  console.log(`  1. AuthAllowlist row created (_id=${created.id})`);
  console.log(`  2. User row created (_id=${userRow.id})`);
  console.log(`  3. RoleAuditLog authAllowlist.add written (actorRoles=${JSON.stringify(actorRow?.roles ?? [])})`);

  // -- 8. verify ------------------------------------------------------------
  console.log(`\n=== VERIFY ===`);
  const vAllow = await db.authAllowlist.findUnique({ where: { pinnedUserID: PIN } });
  const vUser = await db.user.findFirst({
    where: { email: { equals: EMAIL, mode: "insensitive" } },
    select: { email: true, userID: true, displayName: true, passwordHash: true },
  });
  console.log(`  AuthAllowlist: ${vAllow ? JSON.stringify({ email: vAllow.email, pinnedUserID: vAllow.pinnedUserID, addedBy: vAllow.addedBy }) : "MISSING"}`);
  console.log(`  User:          ${vUser ? JSON.stringify(vUser) : "MISSING"}`);
  if (!vAllow || !vUser) {
    // The transaction committed (we are past it) but a read-back does not see
    // both rows. That is a read problem, not a write one — but it must not be
    // reported as success, and the operator needs to know that the RECOVERY here
    // is not "re-run --commit" (which would refuse on the rows that ARE there).
    return abort(
      `read-back failed — the state above is not what was intended. The transaction ` +
        `COMMITTED, so this is a read that disagrees with a write that succeeded. Re-run ` +
        `WITHOUT --commit (the dry run prints the full current state) before doing ` +
        `anything else; do not re-run with --commit, which will refuse on whichever rows ` +
        `do exist.`,
    );
  }
  if (vUser.passwordHash) {
    console.error(
      `  ! the User row has a passwordHash. It was supposed to be absent so that the ` +
        `reset flow is the only way in.`,
    );
    process.exitCode = 1;
  }

  console.log(
    `\nNEXT: this account holds NO ROLES and CANNOT sign in yet (no passwordHash —\n` +
      `auth.ts's authorize refuses). Grant "Hall Office" through /admin/users -> Manage\n` +
      `roles (which audits), and have them use Forgot password. Do NOT let them sign in\n` +
      `before the grant: without it the strict profile gate has nothing exempting them.`,
  );

  if (PRINT_LINK) await mintResetLink();
}

/**
 * BELT AND BRACES BEHIND THE TRANSACTION. Called from the one catch around the
 * three creates, and its whole job is to make the header's invariant — a failed
 * run leaves the cluster re-runnable — true even if the transaction did not do
 * what transactions are supposed to do.
 *
 * WHY IT EXISTS AT ALL, given that Mongo aborts the transaction on failure. The
 * atomicity has PREREQUISITES: a replica set (Atlas is one), and all three
 * collections existing, because MongoDB will not implicitly create a collection
 * inside a transaction. If either is untrue, the driver's error can arrive after
 * some of the writes have gone through as ordinary un-transacted inserts, and
 * separately a commit can succeed on the server while the acknowledgement is
 * lost on the way back. In both cases the client sees a throw and the cluster
 * holds rows. The one state that breaks re-running is the ORPHAN PIN — an
 * AuthAllowlist row with no User row — because it trips both EMAIL_ALREADY_PINNED
 * and PIN_ALREADY_USED, and NO SCRIPT IN THIS REPOSITORY DELETES SUCH A ROW.
 *
 * So this reads the cluster back and acts on what is actually there:
 *   - nothing written        -> the transaction rolled back. Re-run and it works.
 *   - orphan pin, no user    -> DELETE the pin this run created, restoring the
 *                               "nothing written" state above.
 *   - the delete also fails  -> print the EXACT recovery command. Naming the
 *                               remedy is the entire point; "it must be cleaned
 *                               up" is what the operator used to be told.
 *   - both rows present      -> the provisioning actually LANDED. Say so, and
 *                               say that the audit row is the thing to check.
 *
 * The compensating delete is keyed on the EXACT pair (this pin AND this email),
 * never on the pin alone. A pin that turns out to hold somebody else's address
 * is not ours to delete — that is the row PIN_ALREADY_USED exists to protect,
 * and deleting it would be this script un-provisioning an unrelated account.
 *
 * Always returns false (via abort) so the caller can `return await` it.
 */
async function recoverFromFailedWrite() {
  console.error(`\n--- [4] RECOVERY: what is actually in the cluster now ---`);

  let allowRow = null;
  let userRowNow = null;
  try {
    allowRow = await db.authAllowlist.findUnique({ where: { pinnedUserID: PIN } });
    userRowNow = await db.user.findFirst({
      where: { email: { equals: EMAIL, mode: "insensitive" } },
      select: { id: true, email: true, userID: true },
    });
  } catch (readErr) {
    // A failed probe must never read as "nothing is there" — that is the
    // fabricated-zero class, and here it would tell the operator to re-run a
    // command that is about to refuse.
    console.error(`  ! could not read the cluster back: ${String(readErr?.message ?? readErr)}`);
    printOrphanRecoveryCommand();
    return abort(
      `the write failed AND the state could not be read back. Assume an orphan pin may ` +
        `exist and resolve it with the command above before re-running.`,
    );
  }

  console.log(`  AuthAllowlist row for ${JSON.stringify(PIN)}: ${allowRow ? "PRESENT" : "absent"}`);
  console.log(`  User row for ${JSON.stringify(EMAIL)}:        ${userRowNow ? "PRESENT" : "absent"}`);

  if (!allowRow && !userRowNow) {
    return abort(
      `nothing was written — the transaction rolled back in full. RE-RUNNING THE SAME ` +
        `COMMAND IS THE FIX once the cause above is resolved.`,
    );
  }

  if (allowRow && userRowNow) {
    return abort(
      `both rows are PRESENT, so the provisioning committed and the error above was ` +
        `raised after the fact (a lost acknowledgement, or a failure on the way back). ` +
        `Do NOT re-run with --commit; it will refuse. Re-run WITHOUT --commit to see the ` +
        `state, and CHECK RoleAuditLog for an action="authAllowlist.add" row targeting ` +
        `${JSON.stringify(PIN)} — it was in the same transaction, so it should be there.`,
    );
  }

  if (!allowRow && userRowNow) {
    // A User row with no pin. Harmless in the way the reverse is not: it mints
    // no identity, because identity comes from the allowlist. But a re-run now
    // trips USER_ALREADY_EXISTS, so the operator must be told what to do.
    return abort(
      `a User row exists with NO AuthAllowlist row. It mints no identity — the pin is ` +
        `what does that — so nobody can sign in as it, but a re-run will refuse with ` +
        `USER_ALREADY_EXISTS. Delete that User row (it is _id=${userRowNow.id}), or add ` +
        `the pin through /admin -> Auth allowlist, which audits.`,
    );
  }

  // THE ONE THAT BREAKS RE-RUNNING: an orphan pin. Compensate.
  if (allowRow.email !== EMAIL) {
    return abort(
      `an AuthAllowlist row holds ${JSON.stringify(PIN)} but pins ` +
        `${JSON.stringify(allowRow.email)}, not ${JSON.stringify(EMAIL)}. THIS RUN DID NOT ` +
        `WRITE IT and this script will not delete somebody else's pin. Choose a different ` +
        `pin, or remove that one deliberately through /admin -> Auth allowlist.`,
    );
  }

  console.error(
    `  orphan pin detected: the AuthAllowlist row landed and the User row did not.\n` +
      `  Deleting it, so that re-running this command works.`,
  );
  try {
    await db.authAllowlist.delete({ where: { pinnedUserID: PIN } });
  } catch (delErr) {
    console.error(`  ! the compensating delete FAILED: ${String(delErr?.message ?? delErr)}`);
    printOrphanRecoveryCommand();
    return abort(
      `an ORPHAN AuthAllowlist row survives and this script could not remove it. Re-running ` +
        `will refuse with EMAIL_ALREADY_PINNED and PIN_ALREADY_USED until it is gone. Use ` +
        `the command above.`,
    );
  }
  console.log(`  orphan removed. The cluster is back to the pre-run state.`);
  return abort(
    `the write failed and was rolled back (the orphan pin it left was deleted). Resolve ` +
      `the cause printed above, then RE-RUN THE SAME COMMAND.`,
  );
}

/**
 * The exact recovery, spelled out. An operator reading this is mid-rollout with
 * an orphan pin, and "it must be cleaned up" is not an instruction.
 *
 * The tRPC surface is listed FIRST because it audits. Its one refusal,
 * PIN_STILL_HOLDS_ROLES, cannot apply to a row this script wrote: the
 * PIN_ALREADY_HAS_ROLES refusal above proved there was no UserRole row under
 * this pin minutes ago, and this script never grants roles. If it somehow does
 * refuse, that is itself the finding — something granted roles to this pin —
 * and the raw delete below must NOT be used to paper over it.
 */
function printOrphanRecoveryCommand() {
  console.error(
    `\n  *** RECOVERY — remove the orphan AuthAllowlist row ***\n\n` +
      `  Preferred (audited): sign in as an admin, /admin -> Auth allowlist, remove the\n` +
      `  entry for ${JSON.stringify(PIN)}. That is admin.removeAuthAllowlistEntry, which\n` +
      `  writes an authAllowlist.remove audit row.\n\n` +
      `  If the surface is unreachable, in mongosh against this cluster:\n\n` +
      `    db.AuthAllowlist.deleteOne({ pinnedUserID: ${JSON.stringify(PIN)}, email: ${JSON.stringify(EMAIL)} })\n\n` +
      `  BOTH fields in the filter, deliberately: on the pin alone this would delete\n` +
      `  whatever row currently holds that pin, including one belonging to somebody\n` +
      `  else. Expect { deletedCount: 1 }. A raw delete writes NO audit row, so record\n` +
      `  it by hand. Then re-run this script.`,
  );
}

/**
 * Mints a PasswordResetSession and prints the URL. An EXACT mirror of
 * src/app/api/reset-password/request-verification-code/route.ts: 32 random
 * bytes as hex, a 15-minute TTL, and every prior outstanding token for this
 * address deleted first so only one link is ever live.
 *
 * The token is the ONLY trusted input on the consume side — reset-password's
 * route derives the account from the stored session row, never from a
 * client-supplied email — so printing this URL is exactly as powerful as being
 * able to read the person's mailbox for the next 15 minutes. Hand it over
 * directly and to nobody else.
 */
async function mintResetLink() {
  const base = process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? null;
  if (!base) {
    return abort(
      `--print-reset-link needs APP_URL (or NEXTAUTH_URL) in the environment — it is the ` +
        `same value the route uses to build the link, and a link against the wrong origin ` +
        `is a link to nowhere. Note the production APP_URL has been wrong before; a link ` +
        `pointing at localhost is the symptom.`,
    );
  }

  if (!COMMIT) {
    console.log(`\n--- reset link (DRY RUN) ---`);
    console.log(`  would delete outstanding PasswordResetSession rows for ${JSON.stringify(EMAIL)}`);
    console.log(`  would create one with a 32-byte hex token, expiring in 15 minutes`);
    console.log(`  would print ${base}/reset-password?token=<token>`);
    console.log(`  DRY RUN — no token was minted.`);
    return;
  }

  const token = randomBytes(32).toString("hex");
  const deleted = await db.passwordResetSession.deleteMany({ where: { email: EMAIL } });
  await db.passwordResetSession.create({
    data: { email: EMAIL, token, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
  });

  console.log(`\n--- reset link ---`);
  console.log(`  invalidated ${deleted.count} earlier outstanding token(s) for this address`);
  console.log(`  expires: ${new Date(Date.now() + TOKEN_TTL_MS).toISOString()}  (15 minutes)`);
  console.log(`\n  ${base}/reset-password?token=${token}\n`);
  console.log(
    `  HAND THIS OVER OUT OF BAND, to the account owner and nobody else. Anyone\n` +
      `  holding it can set this account's password for the next 15 minutes.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
