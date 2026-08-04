/**
 * Pre/post flight for the admin user-detail feature (/admin/users → Details,
 * and the account delete behind `admin.userDelete.enabled`).
 *
 *   node scripts/remediation/verify-user-admin-safety.mjs
 *   node scripts/remediation/verify-user-admin-safety.mjs --names
 *
 * THIS SCRIPT PERFORMS NO WRITES. There is no --commit flag, deliberately — it
 * measures the population an IRREVERSIBLE feature will act on, and a measurement
 * tool with a write path is a tool someone eventually runs with the wrong
 * argument. Every database call below is findAll() / countWhere() /
 * aggregateAll(), all of which issue `find` / `aggregate` and nothing else.
 * `isCommit()` is consulted ONLY to refuse.
 *
 * Exits 1 on any RED line, matching rbac-doctor.mjs, so it can gate a rollout.
 *
 * RUN IT BEFORE AND AFTER any manual test of the delete path. Lines 3, 4 and 5
 * are the invariants `deleteUserAccountCascade` exists to preserve: if a delete
 * moves any of them off zero, the cascade dropped a collection.
 *
 * WHAT EACH LINE IS FOR:
 *   1  keyMismatch accounts        the population userAdmin.delete REFUSES
 *   1b User rows sharing one id    the SHARED_CANONICAL_ID population
 *   2  CCAs with exactly one head  the SOLE_HEAD_OF_CCA population
 *   3  orphaned UserRole rows      RED — the escalation residue, BUT only the
 *                                 rows the audit log cannot explain as a grant
 *                                 made ahead of signup (see the block at 3/4:
 *                                 the two populations look identical and the
 *                                 first version of this script conflated them)
 *   4  orphaned CcaHead rows       RED — the dead-cca_head residue, same split
 *   5  CH-1 drift                  RED — string <-> row disagreement
 *   6  User.block BSON types       informational; the WARN-only validator
 */
import { PrismaClient } from "@prisma/client";
import { canonicalUserID, isCanonicalResidentID } from "./lib/identity.mjs";
import { findAll, numify, aggregateAll, isCommit, abort } from "./lib/rbac.mjs";

const db = new PrismaClient();
const ALL_NAMES = process.argv.includes("--names");

const red = [];
const W = 46;

/** One report line. `bad` non-empty makes it RED and records the offenders. */
function line(label, value, { bad = null, note = "", info = false } = {}) {
  const isRed = Array.isArray(bad) ? bad.length > 0 : !!bad;
  const tag = isRed ? "  <- RED" : info ? "  [informational]" : "";
  console.log(
    `${label.padEnd(W, ".")} ${String(value).padStart(5)}${tag}${note ? `  ${note}` : ""}`,
  );
  if (isRed) {
    const list = Array.isArray(bad) ? bad : [];
    red.push({ label, value, offenders: list });
    if (list.length) {
      const shown = ALL_NAMES ? list : list.slice(0, 20);
      console.error(
        `      ${shown.join(", ")}${!ALL_NAMES && list.length > 20 ? `  … (+${list.length - 20} more; --names for all)` : ""}`,
      );
    }
  }
}

const sample = (list) =>
  (ALL_NAMES ? list : list.slice(0, 20)).join(", ") +
  (!ALL_NAMES && list.length > 20
    ? `  … (+${list.length - 20} more; --names for all)`
    : "");

async function main() {
  // Defence in depth. Nothing below can write, but a run invoked with --commit
  // means the operator believes they are running a migration; refuse rather than
  // print a measurement under a banner they will misread.
  if (isCommit()) {
    return abort(
      "verify-user-admin-safety.mjs is READ-ONLY and has no write path. Drop --commit / APPLY=yes.",
    );
  }

  console.log(
    `\n=== verify-user-admin-safety.mjs (READ-ONLY) ===  ${new Date().toISOString()}\n`,
  );

  const users = await findAll(db, "User", { _id: 1, email: 1, userID: 1 });
  const userRole = await findAll(db, "UserRole", {
    userID: 1,
    roles: 1,
    role: 1,
  });
  const ccaHead = await findAll(db, "CcaHead", { userID: 1, ccaID: 1 });

  // The live canonical population, keyed exactly as the app keys it. Built with
  // canonicalUserID from lib/identity.mjs — the MIRROR of src/lib/identity.ts,
  // whose parity is gated by verify-identity-parity.mjs. Never re-implement the
  // derivation here: a second copy is how the orphan hunt starts disagreeing
  // with the code it is auditing.
  const liveCanonical = new Set();
  for (const u of users) {
    const id = canonicalUserID(u.email);
    if (isCanonicalResidentID(id)) liveCanonical.add(id);
  }

  line("users(total)", users.length);
  line("users(eligible canonical identities)", liveCanonical.size);

  /* ---- 1. keyMismatch: the accounts the delete REFUSES ------------------- */
  //
  // Exactly admin.listUsers' `keyMismatch` flag, and exactly
  // computeDeleteRefusals' LEGACY_KEY_MISMATCH. These are the split identities
  // the one-off scripts exist for: fix-claresta-duplicate.mjs documents an
  // account whose stored User.userID is ANOTHER live user's canonical key.
  // Cleaning dependents under a key that is not provably this row's is how you
  // delete a stranger's bookings, so the feature declines them by design.
  //
  // Informational, NOT red: it is a pre-existing data fact, and a gate that can
  // never reach zero gets commented out — which deletes the detector.
  const mismatched = [];
  for (const u of users) {
    const stored = typeof u.userID === "string" ? u.userID : "";
    if (!stored) continue;
    if (stored !== canonicalUserID(u.email)) {
      mismatched.push(`${u.email} (stored ${stored})`);
    }
  }
  line("keyMismatch accounts (delete REFUSES these)", mismatched.length, {
    info: true,
    note: "LEGACY_KEY_MISMATCH — use a hand-audited merge script",
  });
  if (mismatched.length) console.log(`      ${sample(mismatched)}`);

  /* ---- 1b. User rows sharing ONE canonical id --------------------------- */
  //
  // The population `computeDeleteRefusals` refuses with SHARED_CANONICAL_ID.
  // LEGACY_KEY_MISMATCH above proves a row's canonical key is COMPLETE; this
  // one is about the other half — whether it is EXCLUSIVE. The cascade removes
  // ONE User document by _id but cleans thirteen collections by
  // `{ userID: cid }`, so if two rows resolve to one id, deleting either takes
  // the OTHER account's roles, headships, matric and bookings while its User row
  // survives, stripped. `email_unique_ci` does not prevent it: that collation
  // folds CASE, not WHITESPACE, and canonicalUserID trims — merge-by-canonical.mjs
  // exists for exactly these sets.
  //
  // Informational, NOT red, on the same reasoning as line 1: it is a pre-existing
  // data fact the feature declines rather than a residue the feature created. It
  // is printed BEFORE the delete is armed so the operator knows the size of the
  // population that will refuse.
  //
  // IT IS NOT ONLY THE DELETE THAT REFUSES. `userAdmin.updateProfile` refuses
  // the CANONICAL-keyed half of a save on these rows too — the UserMatric write
  // and the ProfileCompletion clearing — because those land on the shared id
  // while displayName/block/telegramHandle/bio land on the `_id` that was
  // clicked, i.e. one save reaching two different humans. So this count is also
  // the number of accounts whose matric field the detail dialog will show
  // read-only.
  const byCanonical = new Map();
  for (const u of users) {
    const id = canonicalUserID(u.email);
    if (!isCanonicalResidentID(id)) continue;
    if (!byCanonical.has(id)) byCanonical.set(id, []);
    byCanonical.get(id).push(u.email);
  }
  const shared = [...byCanonical]
    .filter(([, emails]) => emails.length > 1)
    .map(
      ([id, emails]) =>
        `${id} (${emails.map((e) => JSON.stringify(e)).join(" | ")})`,
    );
  line("User rows sharing one canonical id", shared.length, {
    info: true,
    note: "SHARED_CANONICAL_ID — merge with merge-by-canonical.mjs first",
  });
  if (shared.length) console.log(`      ${sample(shared)}`);

  /* ---- 2. CCAs with exactly one head ------------------------------------ */
  //
  // The SOLE_HEAD_OF_CCA population. setCcaHeads: "a headless CCA is the
  // unrecoverable state", so deleting any of these people is refused until the
  // CCA is handed over with admin.transferCcaHead. Informational — a
  // single-headed CCA is normal, it just constrains who may be deleted.
  const headsByCca = new Map();
  for (const h of ccaHead) {
    const id = numify(h.ccaID);
    headsByCca.set(id, (headsByCca.get(id) ?? 0) + 1);
  }
  const soleHeaded = [...headsByCca]
    .filter(([, n]) => n === 1)
    .map(([id]) => String(id));
  line("CCAs with exactly one head", soleHeaded.length, {
    info: true,
    note: "SOLE_HEAD_OF_CCA — transfer before deleting that head",
  });
  if (soleHeaded.length) console.log(`      ccaIDs ${sample(soleHeaded)}`);

  /* ---- 3/4. ORPHANS — AND THE TWO VERY DIFFERENT THINGS THAT PRODUCE THEM */
  //
  // An "orphan" is a privilege row keyed on an id no live User canonicalises to.
  // The first version of this script called EVERY one of them residue and told
  // the operator to resolve them before arming the delete. Measured against
  // production on 2026-08-04 that was WRONG, and wrong in the expensive
  // direction: all 16 orphans were legitimate, and following the instruction
  // would have destroyed eight real CCA-head appointments.
  //
  // TWO POPULATIONS, IDENTICAL IN SHAPE, OPPOSITE IN MEANING:
  //
  //   (a) A GRANT MADE AHEAD OF SIGNUP. admin.grantCcaHead writes CcaHead +
  //       UserRole keyed on the canonical id whether or not that person has ever
  //       signed in — the same trust boundary PendingRoleGrant documents
  //       ("whoever first controls that NUS address gets this grant"). Until
  //       they sign up there is no User row, so the rows look exactly like
  //       residue. E1512588 sat in this state from 2026-07-19 to 2026-08-04.
  //       INTENDED. Not red. Deleting it revokes a real appointment.
  //
  //   (b) RESIDUE A DELETE LEFT BEHIND. The thing this feature exists to never
  //       create: a role row inherited by whoever next signs in on that address
  //       (05-verification.md §613), or a CcaHead row keeping a dead `cca_head`
  //       string alive that revokeCcaHead's `remaining === 0` can never clear
  //       (cascade.ts GUARD 2). RED.
  //
  // THE DISCRIMINATOR IS THE AUDIT LOG, and it is only sound because every
  // privileged mutation writes one. An id with a `user.delete` row whose
  // privilege rows are STILL PRESENT is a cascade that did not finish — that is
  // the failure this script is the detector for, and it stays RED. An id with a
  // grant and no delete is case (a). An id with NEITHER is unexplained: it
  // predates the audit log or came from a hand-run script, and it stays RED
  // because "I cannot account for this privilege row" is not a green condition.
  //
  // A caveat the reader must keep: this classifies by INTENT, not by safety.
  // Case (a) is still an unclaimed credential sitting on an address, and it is
  // still how the duplicate-account trap is baited — the grantee signs up on
  // their alias, sees none of it, and registers a second account on the E-number
  // to claim it (that is exactly how CHUAMINGYUAN / E1512588 happened). It is
  // reported, loudly, as its own line. It just is not a reason to refuse to arm
  // a delete feature that had nothing to do with creating it.
  const auditRows = await findAll(db, "RoleAuditLog", {
    targetUserID: 1,
    action: 1,
  });
  const deletedIds = new Set();
  const grantedIds = new Set();
  for (const a of auditRows) {
    const id = String(a.targetUserID ?? "");
    if (!id) continue;
    const action = String(a.action ?? "");
    if (action === "user.delete") deletedIds.add(id);
    // Any action that CONFERS privilege on an id. `revoke` is deliberately
    // absent: a revoke leaves nothing to be orphaned.
    else if (
      action === "ccaHead.grant" ||
      action === "ccaHead.transfer" ||
      action === "grant" ||
      action === "set" ||
      action === "pending.create" ||
      action === "pending.claim"
    )
      grantedIds.add(id);
  }

  /** (a) intended-and-waiting, (b) residue, or unexplained. */
  function classify(id) {
    if (deletedIds.has(id)) return "residue";
    if (grantedIds.has(id)) return "awaiting-signup";
    return "unexplained";
  }

  const orphanRoleIds = userRole
    .map((r) => String(r.userID ?? ""))
    .filter((id) => id && !liveCanonical.has(id));
  const orphanHeadRows = ccaHead
    .filter((h) => {
      const id = String(h.userID ?? "");
      return id && !liveCanonical.has(id);
    })
    .map((h) => ({ id: String(h.userID), label: `${h.userID}@cca${numify(h.ccaID)}` }));

  const roleResidue = orphanRoleIds.filter((id) => classify(id) !== "awaiting-signup");
  const roleWaiting = orphanRoleIds.filter((id) => classify(id) === "awaiting-signup");
  const headResidue = orphanHeadRows.filter((h) => classify(h.id) !== "awaiting-signup");
  const headWaiting = orphanHeadRows.filter((h) => classify(h.id) === "awaiting-signup");

  line("orphaned UserRole rows (RESIDUE)", roleResidue.length, {
    bad: roleResidue,
    note: "inherited by the next signup on that address (05 §613)",
  });
  if (roleResidue.length) {
    const unexplained = roleResidue.filter((id) => classify(id) === "unexplained");
    const deleted = roleResidue.filter((id) => classify(id) === "residue");
    if (deleted.length)
      console.log(`      after a user.delete (cascade did not finish): ${sample(deleted)}`);
    if (unexplained.length)
      console.log(`      no audit history at all (pre-audit or hand-run): ${sample(unexplained)}`);
  }

  line("orphaned CcaHead rows (RESIDUE)", headResidue.length, {
    bad: headResidue.map((h) => h.label),
    note: "revokeCcaHead's remaining===0 can never fire (GUARD 2)",
  });

  // Not red — but the duplicate-account trap, so it is never silent.
  line("grants awaiting first signup (UserRole)", roleWaiting.length, {
    info: true,
    note: "INTENDED — do NOT clear; see the duplicate-account note below",
  });
  if (roleWaiting.length) console.log(`      ${sample(roleWaiting)}`);
  line("grants awaiting first signup (CcaHead)", headWaiting.length, {
    info: true,
    note: "INTENDED — these are appointments, not residue",
  });
  if (headWaiting.length) console.log(`      ${sample(headWaiting.map((h) => h.label))}`);
  if (roleWaiting.length || headWaiting.length) {
    console.log(
      `      NOTE: each of these people is set up to create a DUPLICATE ACCOUNT.\n` +
        `      The grant is keyed to their E-number; if they sign up with their NUS\n` +
        `      alias address they get none of it and register a second account to\n` +
        `      claim it. That is exactly how CHUAMINGYUAN / E1512588 happened.`,
    );
  }

  /* ---- 5. CH-1 drift — RED ---------------------------------------------- */
  //
  // CH-1: a user holds the `cca_head` string IFF they have >= 1 CcaHead row.
  // Checked in BOTH directions, because the delete removes the string (via the
  // whole UserRole document) and the rows in ONE transaction — if either side
  // survives alone, the cascade dropped a collection.
  const headRowUsers = new Set(
    ccaHead.map((h) => String(h.userID ?? "")).filter(Boolean),
  );
  const stringHolders = new Set(
    userRole
      .filter((r) => {
        const stored = r.roles?.length ? r.roles : r.role ? [r.role] : [];
        return stored.includes("cca_head");
      })
      .map((r) => String(r.userID ?? ""))
      .filter(Boolean),
  );
  const stringNoRow = [...stringHolders].filter((id) => !headRowUsers.has(id));
  const rowNoString = [...headRowUsers].filter((id) => !stringHolders.has(id));
  line("CH-1 drift: cca_head string, NO CcaHead row", stringNoRow.length, {
    bad: stringNoRow,
  });
  line("CH-1 drift: CcaHead row, NO cca_head string", rowNoString.length, {
    bad: rowNoString,
  });

  /* ---- 6. User.block BSON type distribution ----------------------------- */
  //
  // The `User` collection's validator declares `block` as bsonType "int",
  // minimum 1, maximum 8 — with validationAction "warn". A NON-CONFORMING WRITE
  // IS ACCEPTED SILENTLY and only logged; there is no safety net at the
  // database, which is why the admin edit writes block through Prisma's Int
  // mapping in exactly the shape user.updateUserData and the register route
  // already use.
  //
  // If this reports anything other than int / missing, those writers are ALREADY
  // producing it and the admin edit changes nothing — but the house should know.
  // Counter-evidence worth remembering: services/ccaMembers.ts observed Prisma's
  // Mongo connector sending an Int as a 64-bit long, rejected by UserCCA's int32
  // validator with code 121. Matching the existing writer, rather than reasoning
  // about what Prisma "should" send, is the safe move.
  const blockTypes = await aggregateAll(db, "User", [
    { $group: { _id: { $type: "$block" }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  if (!blockTypes.ok) {
    line("User.block BSON type distribution", "ERR", {
      info: true,
      note: blockTypes.errmsg,
    });
  } else {
    const parts = blockTypes.rows.map((r) => `${String(r._id)}:${numify(r.n)}`);
    line("User.block BSON type distribution", blockTypes.rows.length, {
      info: true,
      note: parts.join("  ") || "(no rows)",
    });
  }

  /* ---- verdict ---------------------------------------------------------- */
  console.log(`\n================================`);
  if (red.length) {
    console.error(`RED LINES: ${red.length}`);
    for (const r of red)
      console.error(`  RED  ${r.label.replace(/\.+$/, "")} = ${r.value}`);
    console.error(
      `\nThese are privilege residues the audit log CANNOT explain as a grant\n` +
        `made ahead of signup. Resolve them BEFORE arming\n` +
        `admin.userDelete.enabled — a delete run over an already-drifted\n` +
        `population cannot be told apart from a delete that caused the drift.\n` +
        `\n` +
        `Do NOT clear the "awaiting first signup" lines above to get here: those\n` +
        `are live appointments whose holder has not signed in yet.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `All gating lines green. This script wrote nothing.\n` +
      `Re-run it after any manual delete: lines 3-5 must still be zero.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
