/**
 * RBAC health check. READ-ONLY, safe to run at any time, exits 1 on any RED
 * line. Run it DAILY through the rollout.
 *
 *   node scripts/remediation/rbac-doctor.mjs
 *   node scripts/remediation/rbac-doctor.mjs --names   # print every offending id
 *   node scripts/remediation/rbac-doctor.mjs --nonnus  # 08 §2 measurement, read-only
 *
 * This is the detection query that is otherwise missing everywhere. It is also
 * surfaced as an /admin health panel (03-admin-dashboard.md) with per-user
 * identifier lists for admin only and aggregate counts for jcrc.
 *
 * WHICH LINES GATE WHAT:
 *   Phase 2 DEPLOY is gated by     — the two "missing legacy" lines and
 *                                    "orphans under the OLD key".
 *   The enforcement FLIP past off  — "eligible users MISSING resident",
 *                                    "UNCONFIGURED", "shadow denials, last 24h".
 *
 * By default every RED line prints up to 20 offending identifiers; --names
 * prints all of them. A bare count is not actionable (I-16).
 *
 * THE AuthAllowlist SECTION is the D-7 break-glass detector (08 §3 Branch C).
 * It asserts pin uniqueness FROM THE DATA rather than from `listIndexes`, so a
 * skipped create-auth-allowlist.mjs — which leaves the Prisma @unique enforcing
 * nothing — is still visible here. The collection being ABSENT is the normal
 * pre-rollout state and is reported, never RED. See allowlistSection() below.
 *
 * "eligible users MISSING it" is computed over User rows whose email matches
 * the anchored NUS regex ONLY. Counting non-NUS rows there would make it a line
 * that can NEVER reach zero, and a gate that can never reach zero gets
 * commented out — which deletes the detector.
 *
 * --nonnus is a SEPARATE, non-gating mode: the 08 §2 measurement that must be
 * taken before a §3 remedy branch can be chosen. It reports, it does not judge,
 * and it never exits 1 — a non-zero non-NUS population is a fact to act on, not
 * a failure. See nonNusReport() below.
 */
import { PrismaClient } from "@prisma/client";
import {
  canonicalUserID, isCanonicalResidentID, normalizeEmail, isExtUserID,
} from "./lib/identity.mjs";
import {
  findAll, countWhere, numify, E_FORMAT, ROLE_VOCAB, SENTINEL_FACILITY_ID, legacyCanonicalUserID,
  aggregateAll, isCommit, abort,
} from "./lib/rbac.mjs";

const db = new PrismaClient();
const ALL_NAMES = process.argv.includes("--names");
const NONNUS = process.argv.includes("--nonnus");
const raw = (cmd) => db.$runCommandRaw(cmd);

/** Shape test for the ~515 legacy matric ids, same regex as merge-accounts.mjs:63
 *  and inventory-rbac.mjs:52. Census bucketing only — never an eligibility gate
 *  (L-27) and never a key derivation. */
const A_FORMAT = /^A\d{7}[A-Z]$/i;
/** A bare 24-hex string, i.e. something keyed on a Mongo _id rather than a userID. */
const OID_HEX = /^[0-9a-f]{24}$/i;

const red = [];
const W = 46;

/** One report line. `bad` non-empty makes it RED and records the offenders. */
function line(label, value, { bad = null, note = "", info = false } = {}) {
  const isRed = Array.isArray(bad) ? bad.length > 0 : !!bad;
  const tag = isRed ? "  <- RED" : info ? "  [informational]" : "";
  console.log(`${label.padEnd(W, ".")} ${String(value).padStart(5)}${tag}${note ? `  ${note}` : ""}`);
  if (isRed) {
    const list = Array.isArray(bad) ? bad : [];
    red.push({ label, value, offenders: list });
    if (list.length) {
      const shown = ALL_NAMES ? list : list.slice(0, 20);
      console.error(`      ${shown.join(", ")}${!ALL_NAMES && list.length > 20 ? `  … (+${list.length - 20} more; --names for all)` : ""}`);
    }
  }
}

// ---------------------------------------------------------------------------
// AuthAllowlist — the D-7 break-glass, COLLECTION variant (08 §3 Branch C)
//
// READ-ONLY, like everything else in the default mode.
//
// THE THING THIS SECTION IS ACTUALLY FOR. One row here is `{ email,
// pinnedUserID }`, and `pinnedUserID` becomes `session.user.userID` verbatim —
// which IS the authorization key: auth.ts and access.ts both do a bare
// `findUnique({ where: { userID } })` with no provenance check. So a row
// pinning an address to `E1633673` would hand that address an admin's roles
// through NO GRANT PATH AT ALL, meaning not one escalation guard is crossed and
// not one audit row is written.
//
// Four mechanisms stop that, and this section is the DETECTOR for two of them
// failing:
//
//   M2 (namespace enforced at READ time). `asExtUserID` re-validates every pin
//      as it is read, so a hand-written Atlas row mints nothing. A pin failing
//      EXT_ID here is therefore not itself an escalation — it is EVIDENCE that
//      somebody wrote to this collection outside the audited mutation, which is
//      worth waking up for regardless of what the pin says.
//
//   M3 (uniqueness, enforced by a real Mongo index). A Prisma `@unique` on
//      Mongo enforces NOTHING until `createIndexes` has run
//      (create-auth-allowlist.mjs). If that step is skipped, two rows can share
//      a pin and `addAuthAllowlistEntry`'s P2002 refusal can never fire —
//      silently. So uniqueness is asserted HERE FROM THE DATA, not by reading
//      `listIndexes`: a missing index becomes visible the moment it lets a
//      duplicate through, without anyone having to remember to check for it.
//
// It also prints what each pin CARRIES, because the operational rule that an
// EXT identity should never hold `admin` is a policy, not a code guard — and a
// policy nobody can see is not a policy.
//
// ABSENT IS NORMAL. Before create-auth-allowlist.mjs runs, this collection does
// not exist. That is reported and is NOT a RED line and NOT an exit-1.
// ---------------------------------------------------------------------------

/** { present, rows, error }. `present:false` means the collection is absent —
 *  distinguished from "exists and is empty", because those mean different
 *  things about where the rollout has got to. */
async function readAuthAllowlist() {
  try {
    // No server-side filter on listCollections: Atlas rejects
    // `filter: { name: { $in: [...] } }` with "can't get regex from filter doc
    // not a regex" (see preflight-scrc-validators.mjs). Ask for everything,
    // narrow in JS — one round trip, still read-only.
    const lc = await raw({ listCollections: 1 });
    const present = (lc?.cursor?.firstBatch ?? []).some((c) => c?.name === "AuthAllowlist");
    if (!present) return { present: false, rows: [], error: null };
    const rows = await findAll(db, "AuthAllowlist", {
      email: 1, pinnedUserID: 1, note: 1, addedBy: 1, addedAt: 1,
    });
    return { present: true, rows, error: null };
  } catch (e) {
    // FAIL LOUD, never fail quiet. An unreadable allowlist reported as an empty
    // one would print a clean bill of health over exactly the rows this section
    // exists to inspect.
    return { present: null, rows: [], error: String(e?.message ?? e) };
  }
}

function allowlistSection(allowlist, users, userRole) {
  console.log(``);
  if (allowlist.error) {
    line("AuthAllowlist: UNREADABLE", 1, {
      bad: [allowlist.error],
      note: "not a measured zero — resolve before trusting this report",
    });
    return;
  }
  if (allowlist.present === false) {
    line("AuthAllowlist rows", "n/a", {
      info: true,
      note: "collection ABSENT — expected before create-auth-allowlist.mjs",
    });
    return;
  }

  const rows = allowlist.rows ?? [];
  line("AuthAllowlist rows (admin-pinned identities)", rows.length, { info: true });
  if (!rows.length) {
    console.log(`      (collection exists but holds no pins — the break-glass is unused)`);
    return;
  }

  const rolesByID = new Map(userRole.map((r) => [String(r.userID ?? ""), r.roles ?? []]));
  const emailsPresent = new Set(users.map((u) => normalizeEmail(String(u.email ?? ""))));

  // --- M2: every pin must be in the EXT namespace -------------------------
  const notExt = rows
    .filter((r) => !isExtUserID(String(r.pinnedUserID ?? "")))
    .map((r) => `${String(r.email)}->${JSON.stringify(r.pinnedUserID ?? null)}`);
  line("  pins OUTSIDE the EXT: namespace", notExt.length, {
    bad: notExt,
    note: "mints NO identity (M2) — someone wrote this row by hand",
  });

  // --- M3: uniqueness, asserted from the DATA -----------------------------
  const byPin = new Map();
  const byEmail = new Map();
  for (const r of rows) {
    const p = String(r.pinnedUserID ?? "");
    const e = normalizeEmail(String(r.email ?? ""));
    if (!byPin.has(p)) byPin.set(p, []);
    byPin.get(p).push(e);
    byEmail.set(e, (byEmail.get(e) ?? 0) + 1);
  }
  const sharedPins = [...byPin]
    .filter(([, emails]) => emails.length > 1)
    .map(([p, emails]) => `${p} <- ${emails.join(" + ")}`);
  const dupEmails = [...byEmail].filter(([, n]) => n > 1).map(([e, n]) => `${e}(x${n})`);
  line("  pins claimed by MORE THAN ONE email", sharedPins.length, {
    bad: sharedPins,
    note: "M3 BROKEN — the pin_unique index is missing (create-auth-allowlist.mjs)",
  });
  line("  emails appearing more than once", dupEmails.length, {
    bad: dupEmails,
    note: "the email_unique index is missing",
  });

  // --- the operational rule, made visible ---------------------------------
  const extAdmins = rows
    .filter((r) => (rolesByID.get(String(r.pinnedUserID ?? "")) ?? []).includes("admin"))
    .map((r) => `${String(r.pinnedUserID)}(${String(r.email)})`);
  line("  EXT pins holding \"admin\"", extAdmins.length, {
    bad: extAdmins,
    note: "an identity minted from a row, not from an NUS address, with full admin",
  });

  // --- a pinned address that ALSO has a canonical identity ----------------
  //
  // One human, two identity keys: two UserRole rows, two booking owners, two
  // audit trails, and nothing that reconciles them. addAuthAllowlistEntry
  // refuses this (EMAIL_IS_CANONICAL) and so does provision-ext-account.mjs, so
  // a hit here means the row predates those guards or bypassed them.
  const canonicalPinned = rows
    .filter((r) => canonicalUserID(String(r.email ?? "")) !== null)
    .map((r) => `${String(r.email)}->${String(r.pinnedUserID)}`);
  line("  pinned addresses that ALSO canonicalise", canonicalPinned.length, {
    bad: canonicalPinned,
    note: "one human with two identity keys",
  });

  // --- the roster, one line per pin ---------------------------------------
  console.log(`\n      pin                       email                                    roles              User row`);
  for (const r of rows) {
    const pin = String(r.pinnedUserID ?? "(null)");
    const email = normalizeEmail(String(r.email ?? ""));
    const roles = rolesByID.get(pin) ?? [];
    const hasUser = emailsPresent.has(email);
    console.log(
      `      ${pin.padEnd(25)} ${email.padEnd(40)} ${JSON.stringify(roles).padEnd(18)} ` +
        `${hasUser ? "yes" : "NO — session would sign out (accountMissing)"}`,
    );
  }
}

async function main() {
  if (NONNUS) return nonNusReport();
  console.log(`\n=== rbac-doctor.mjs ===  ${new Date().toISOString()}\n`);

  const users = await findAll(db, "User", { _id: 1, email: 1 });
  const userRole = await findAll(db, "UserRole", { userID: 1, roles: 1, role: 1 });
  const facilities = (await findAll(db, "Facilities", { facilityID: 1, facilityName: 1 }))
    .map((f) => ({ ...f, facilityID: numify(f.facilityID) }));
  const access = (await findAll(db, "FacilityAccess", { facilityID: 1, requiredRoles: 1, requiredRole: 1 }))
    .map((a) => ({ ...a, facilityID: numify(a.facilityID) }));

  // D-7 break-glass, the COLLECTION variant. Read BEFORE the population loop
  // because the "INELIGIBLE" line below subtracts these addresses. Absent is
  // the normal pre-rollout state and is not an error — see allowlistSection().
  const allowlist = await readAuthAllowlist();
  const pinnedEmails = new Map(
    (allowlist.rows ?? []).map((r) => [normalizeEmail(String(r.email ?? "")), String(r.pinnedUserID ?? "")]),
  );

  // --- population -------------------------------------------------------
  const eligible = new Map();
  const nonNus = [], blank = [], nonE = [], collisions = [], pinned = [];
  for (const u of users) {
    const e = String(u.email ?? "");
    const id = canonicalUserID(e);
    if (!isCanonicalResidentID(id)) {
      // AN ADDRESS WITH AN ALLOWLIST PIN IS NOT INELIGIBLE. It has no canonical
      // id — that is the whole reason it needs a pin — but resolvePrincipalID
      // gives it an EXT: identity, so it signs in, holds roles and books rooms.
      // Leaving it in the INELIGIBLE bucket labels the hall office as locked
      // out, and a future operator reading this report will go and "fix" a
      // thing that is working exactly as designed — most likely by widening the
      // domain rule, which is the one change this whole mechanism exists to
      // avoid. Counted separately instead.
      if (e.trim() && pinnedEmails.has(normalizeEmail(e))) pinned.push(e);
      else (e.trim() ? nonNus : blank).push(e || String(u._id?.$oid ?? u._id));
      continue;
    }
    if (!E_FORMAT.test(id)) nonE.push(id);
    if (eligible.has(id)) collisions.push(id);
    else eligible.set(id, e);
  }

  line("users(total)", users.length);
  line("users(eligible, canonical has no @)", eligible.size);
  line("users(pinned via AuthAllowlist — sign in as EXT)", pinned.length, {
    info: true, note: "NOT locked out; see the allowlist section" });
  if (pinned.length) console.log(`      ${(ALL_NAMES ? pinned : pinned.slice(0, 20)).join(", ")}`);
  line("users(INELIGIBLE — cannot sign in under D-7)", nonNus.length, {
    info: true, note: "migration list; pinned addresses SUBTRACTED" });
  if (nonNus.length) console.log(`      ${(ALL_NAMES ? nonNus : nonNus.slice(0, 20)).join(", ")}`);
  line("canonical id collisions", collisions.length, { bad: collisions, note: "merged accounts" });
  line("canonical id empty (blank email)", blank.length, { bad: blank });
  line("canonical id not E-format", nonE.length, { info: true, note: "LEGITIMATE — never exclude (L-27)" });

  // --- the D-7 break-glass allowlist ------------------------------------
  allowlistSection(allowlist, users, userRole);

  // --- stored baseline (the flip gate) ----------------------------------
  const withResident = new Set(userRole.filter((r) => (r.roles ?? []).includes("resident")).map((r) => r.userID));
  const missingResident = [...eligible.keys()].filter((id) => !withResident.has(id));
  // Inverse: a stored resident under an id with no eligible NUS account behind
  // it. That is a mis-keyed grant — the row exists but no session matches it.
  const unbackedResident = [...withResident].filter((id) => !eligible.has(id));

  line("UserRole rows with stored resident", withResident.size);
  line("  eligible users MISSING it", missingResident.length, {
    bad: missingResident, note: "live lockout list; BLOCKS the flip past off" });
  line("  resident held with NO eligible account", unbackedResident.length, { bad: unbackedResident });

  // --- shape invariants (the deploy gate) -------------------------------
  const noArr = userRole.filter((r) => !Array.isArray(r.roles)).map((r) => r.userID);
  const noLeg = userRole.filter((r) => r.role === undefined).map((r) => r.userID);
  const nonCanonical = userRole.filter((r) => !isCanonicalResidentID(String(r.userID ?? ""))).map((r) => r.userID);
  const dupCounts = new Map();
  for (const r of userRole) dupCounts.set(r.userID, (dupCounts.get(r.userID) ?? 0) + 1);
  const dupUR = [...dupCounts].filter(([, n]) => n > 1).map(([id, n]) => `${id}(x${n})`);
  const strays = [...new Set(userRole.flatMap((r) => (r.roles ?? []).filter((s) => !ROLE_VOCAB.includes(s))))];

  line("UserRole rows missing roles[]", noArr.length, { bad: noArr });
  line("UserRole rows missing legacy 'role'", noLeg.length, { bad: noLeg, note: "I-2; BLOCKS the Phase 2 deploy" });
  line("UserRole keyed on a non-canonical id", nonCanonical.length, { bad: nonCanonical, note: "I-1" });
  line("UserRole duplicate userID rows", dupUR.length, { bad: dupUR, note: "did the @unique index build?" });
  line("out-of-vocabulary role strings", strays.length, { bad: strays, note: "no $jsonSchema guards roles[]" });

  const missingHash = await countWhere(db, "User", { passwordHash: { $exists: false } });
  line("User rows missing passwordHash", missingHash, {
    bad: missingHash ? ["(count only — see inventory-rbac.mjs)"] : null,
    note: "needs passwordHash String? in schema" });

  // --- orphans under the OLD key (doc 01 Step 4) ------------------------
  let orphanGroups = [];
  for (const u of users) {
    const oldKey = legacyCanonicalUserID(u.email);
    const newKey = canonicalUserID(u.email);
    if (oldKey === newKey || !oldKey) continue;
    for (const coll of ["Bookings", "UserCCA", "UserMatric", "UserRole"]) {
      const n = await countWhere(db, coll, { userID: oldKey });
      if (n) orphanGroups.push(`${coll}:${oldKey}(${n})`);
    }
  }
  line("orphans under the OLD key", orphanGroups.length, {
    bad: orphanGroups, note: "BLOCKS the Phase 2 deploy" });

  // --- facilities -------------------------------------------------------
  const realFacilities = facilities.filter((f) => f.facilityID !== SENTINEL_FACILITY_ID);
  const configured = new Set(access.map((a) => a.facilityID));
  const unconfigured = realFacilities.filter((f) => !configured.has(f.facilityID))
    .map((f) => `${f.facilityID} (${f.facilityName})`);
  const storesAdmin = access.filter((a) => (a.requiredRoles ?? []).includes("admin")).map((a) => a.facilityID);
  const faNoLegacy = access.filter((a) => a.requiredRole === undefined).map((a) => a.facilityID);
  const faResidentMirror = access.filter((a) => a.requiredRole === "resident").map((a) => a.facilityID);

  line("facilities (excl. -1)", realFacilities.length);
  line("  with a FacilityAccess row", realFacilities.length - unconfigured.length);
  line("  UNCONFIGURED", unconfigured.length, { bad: unconfigured, note: "would default to resident; blocks the flip" });
  line("  storing \"admin\" in requiredRoles", storesAdmin.length, { bad: storesAdmin });
  line("FacilityAccess missing legacy scalar", faNoLegacy.length, { bad: faNoLegacy, note: "I-2" });
  line("FacilityAccess requiredRole=\"resident\"", faResidentMirror.length, {
    bad: faResidentMirror, note: "a Phase-2 revert would DENY these rooms to all non-admins (06 §0.1)" });

  // --- deferred privilege ----------------------------------------------
  let pending = [];
  try { pending = await findAll(db, "PendingRoleGrant"); } catch { /* collection may not exist yet */ }
  const nowMs = Date.now();
  // admin | jcrc | scrc — every PRIVILEGED grantable role. Must stay in step
  // with the identical filter in verify-legacy-drop.mjs, which BLOCKS the drop;
  // this one only reports, so a divergence shows up here as a quiet undercount.
  // cca_head cannot travel the deferred path (no ASSIGNABLE_BY entry).
  const privPending = pending.filter((p) => (p.roles ?? []).some((r) => r === "admin" || r === "jcrc" || r === "scrc"));
  const expired = pending.filter((p) => p.expiresAt && new Date(p.expiresAt?.$date ?? p.expiresAt).getTime() <= nowMs);
  line("PendingRoleGrant: outstanding", pending.length);
  line("  of which admin/jcrc/scrc", privPending.length, {
    bad: privPending.map((p) => `${p.userID}:${JSON.stringify(p.roles)}`),
    note: "requires named sign-off before the legacy drop" });
  line("  expired, unclaimed", expired.length, { info: true });

  // --- enforcement + shadow denials -------------------------------------
  const flag = (await raw({ find: "SystemFlag", filter: { key: "rbac.booking.enforcement" }, limit: 1 }))
    ?.cursor?.firstBatch?.[0];
  const mode = flag?.value ?? "(no row — env floor applies, default off)";
  console.log(`${"enforcement mode".padEnd(W, ".")} ${String(mode).padStart(5)}`);

  let shadow = 0;
  try {
    shadow = await countWhere(db, "RoleAuditLog", {
      action: "booking.denied.shadow",
      at: { $gte: { $date: new Date(nowMs - 24 * 3600 * 1000).toISOString() } },
    });
  } catch { /* collection may not exist yet */ }
  line("shadow denials, last 24h", shadow, {
    // Not RED by itself — a non-zero count is the SIGNAL the permissive soak
    // exists to produce. It is a human go/no-go, not a machine gate.
    info: true, note: "go/no-go for \"enforce\"" });

  // --- verdict ----------------------------------------------------------
  console.log(`\n================================`);
  if (red.length) {
    console.error(`RED LINES: ${red.length}`);
    for (const r of red) console.error(`  RED  ${r.label.replace(/\.+$/, "")} = ${r.value}`);
    process.exitCode = 1;
    return;
  }
  console.log(`All lines green${String(mode) === "off" ? ` (enforcement mode: off, as expected pre-flip)` : ""}.`);
}

// ---------------------------------------------------------------------------
// --nonnus — the 08 §2 measurement
//
// Answers, in one command, the four things §2 says must be known before any §3
// remedy can be chosen: who the non-NUS users are, what they own under their
// historical key, how many unattributable rows the §1.1 hazard has already
// written, and what key format the droplet-owned collections actually use.
//
// READ-ONLY BY CONSTRUCTION. Every database call in this path is findAll(),
// countWhere() or aggregateAll(), all of which issue `find` / `getMore` /
// `aggregate` and nothing else. There is no `--commit` branch here and no write
// helper is imported into it; isCommit() is consulted ONLY to refuse.
//
// It does not gate anything, so it does not set exitCode. A non-zero population
// is the answer, not a failure.
// ---------------------------------------------------------------------------

/** Collections keyed by a plain `userID` string. Superset of merge-accounts.mjs's
 *  DEPENDENTS — this is a census, not a reassignment, so nothing is excluded for
 *  being out of scope. */
const OWNED_BY_USERID = ["Bookings", "BookingLogs", "Posts", "UserCCA", "Gym", "Order", "UserMatric", "UserRole"];
/** Written by the droplet's Python backends, never by this repo (08 §2 caveat). */
const DROPLET_OWNED = ["Posts", "UserCCA", "Gym", "Order", "BookingLogs"];

const stat = (label, value, note = "") =>
  console.log(`${label.padEnd(W, ".")} ${String(value).padStart(5)}${note ? `  ${note}` : ""}`);
const sample = (list) => (ALL_NAMES ? list : list.slice(0, 20)).join(", ")
  + (!ALL_NAMES && list.length > 20 ? `  … (+${list.length - 20} more; --names for all)` : "");

/** Renders a $group _id for humans. Extended JSON hands back {$oid:…} for an
 *  ObjectId, and `""` prints as nothing at all unless it is quoted — which is
 *  precisely the value this whole exercise is about. */
function keyLabel(v) {
  if (v === null || v === undefined) return "(missing/null)";
  if (typeof v === "object") return v.$oid ? `ObjectId(${v.$oid})` : JSON.stringify(v);
  return v === "" ? `""(EMPTY)` : String(v);
}

function bucketOf(v) {
  if (v === null || v === undefined) return "missing/null";
  if (typeof v === "object") return v.$oid ? "ObjectId-ish" : "other";
  const s = String(v);
  if (E_FORMAT.test(s)) return "E-format";
  if (A_FORMAT.test(s)) return "A-format";
  if (s.includes("@")) return "email-ish";
  if (OID_HEX.test(s)) return "ObjectId-ish";
  return "other";
}

async function nonNusReport() {
  // Defence in depth. Nothing below can write, but a run invoked with --commit
  // means the operator believes they are running a migration; refuse rather than
  // print a measurement under a banner they will misread.
  if (isCommit()) {
    return abort("--nonnus is a READ-ONLY measurement and has no write path. Drop --commit / APPLY=yes.");
  }

  console.log(`\n=== rbac-doctor.mjs --nonnus (READ-ONLY, 08 §2) ===  ${new Date().toISOString()}`);
  console.log(`No writes are issued by this mode. Nothing here gates a deploy.\n`);

  /** Records a command that FAILED, so a missing collection can never be read as
   *  a measured zero. */
  const unreadable = [];
  async function countChecked(coll, filter) {
    const r = await aggregateAll(db, coll, [{ $match: filter }, { $count: "n" }]);
    if (!r.ok) { unreadable.push(`${coll}: ${r.errmsg}`); return null; }
    return numify(r.rows[0]?.n);
  }

  // --- (1) who they are -------------------------------------------------
  // aggregateAll, NOT findAll: findAll pushes firstBatch without inspecting
  // `ok`, and $runCommandRaw RESOLVES on a failed command. A `find` that failed
  // (no read privilege on User, transient error) would therefore return [] and
  // this mode would print "non-NUS 0" and recommend Branch A over a population
  // it never read — the exact fabricated zero aggregateAll exists to prevent.
  // This is the number the whole §3 branch choice hangs on, so it gets the
  // ok-checked path like every other count below.
  const usersRead = await aggregateAll(db, "User", [{ $project: { email: 1, userID: 1 } }]);
  if (!usersRead.ok) unreadable.push(`User (population): ${usersRead.errmsg}`);
  const users = usersRead.rows;
  const nonNus = [], blankEmail = [];
  for (const u of users) {
    const email = String(u.email ?? "");
    // C9 — READ THIS BEFORE CHANGING THE COMPARISON BACK.
    //
    // This was `canonicalUserID(email) !== ""`. When C9 moved the absent id from
    // "" to null that form did not start throwing or start reporting a wrong
    // number: it went VACUOUSLY TRUE. canonicalUserID never returns "" any more,
    // so `!== ""` holds for EVERY row, the loop `continue`s on every row, and
    // nonNus/blankEmail stay empty.
    //
    // The consequence is specific and bad. This mode's entire job is to FIND the
    // non-NUS population before the D-7 cutover; §3's branch choice (and the
    // operator's decision to proceed) hangs on this count. A silently-empty
    // result reads as "clean bill of health — no affected users" for exactly the
    // population the tool exists to enumerate, and nothing downstream contradicts
    // it, because [2] and [3] both iterate `nonNus`. A wrong number would have
    // been caught by eye; a confident zero would not.
    //
    // Written falsy, not `=== null`: `!id` is true for both null and "", so this
    // gate cannot be quietly disarmed again by a future change to how absence is
    // represented. Every absent id is an affected row here no matter its shape.
    if (canonicalUserID(email)) continue;
    // Same split as the main report (:70): a blank email is also an absent
    // canonical, but it is a different defect and must not be counted as a person.
    (email.trim() ? nonNus : blankEmail).push(u);
  }

  console.log(`--- [1] non-NUS User rows (08 §2a) ---`);
  if (!usersRead.ok) {
    console.log(`  UNREADABLE — ${usersRead.errmsg}`);
    console.log(`  Every count below is over ZERO User rows and means NOTHING. Fix this first.`);
  }
  stat("users(total)", users.length);
  stat("users(non-NUS — the affected population)", nonNus.length);
  stat("users(blank email — not people, listed apart)", blankEmail.length);
  if (blankEmail.length) console.log(`      ${sample(blankEmail.map((u) => String(u._id?.$oid ?? u._id)))}`);

  if (!nonNus.length) {
    console.log(`\n      (none — nothing to key under a legacy value)`);
  } else {
    console.log(`\n  email                                    User.userID      legacy runtime key`);
    for (const u of nonNus) {
      // legacyCanonicalUserID, NOT an inline re-derivation: two copies of the
      // pre-merge transform drift, and the whole hunt is only correct if this
      // is byte-identical to what wrote the rows.
      const legacy = legacyCanonicalUserID(u.email);
      console.log(`  ${String(u.email).padEnd(40)} ${String(u.userID ?? "(null)").padEnd(16)} ${legacy}`);
    }
  }

  // --- (2) what they own under the legacy key ---------------------------
  console.log(`\n--- [2] rows owned under the legacy key (08 §2b) ---`);
  const owners = [];   // non-NUS users with at least one row somewhere
  if (!nonNus.length) console.log(`  (no non-NUS users — nothing is keyed on a legacy value)`);
  else console.log(`  email                                      rows  per-collection breakdown`);
  for (const u of nonNus) {
    const legacy = legacyCanonicalUserID(u.email);
    const hits = [];
    for (const coll of OWNED_BY_USERID) {
      const n = await countChecked(coll, { userID: legacy });
      if (n) hits.push(`${coll}:${n}`);
    }
    // SupperGroup carries membership on BOTH fields; an equality match against
    // userIdList matches any ELEMENT, which is the intended semantics here.
    const owned = await countChecked("SupperGroup", { ownerId: legacy });
    const member = await countChecked("SupperGroup", { userIdList: legacy });
    if (owned) hits.push(`SupperGroup.ownerId:${owned}`);
    if (member) hits.push(`SupperGroup.userIdList:${member}`);

    const total = hits.reduce((s, h) => s + Number(h.split(":").pop()), 0);
    if (total) owners.push({ email: u.email, legacy, total, hits });
    console.log(`  ${String(u.email).padEnd(40)} ${String(total).padStart(5)}  ${hits.join("  ") || "(no rows anywhere)"}`);
  }
  console.log(``);
  stat("non-NUS users owning at least one row", owners.length,
    owners.length ? "REAL DATA — see the verdict" : "");

  // --- (3) rows the §1.1 hazard already wrote ---------------------------
  console.log(`\n--- [3] unattributable Bookings (08 §2, the "" hazard) ---`);
  const grouped = await aggregateAll(db, "Bookings",
    [{ $group: { _id: "$userID", n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
  let emptyRows = 0, junk = [], junkRows = 0;
  if (!grouped.ok) {
    unreadable.push(`Bookings (group): ${grouped.errmsg}`);
    console.log(`  UNREADABLE — ${grouped.errmsg}`);
  } else {
    // "any live user" is deliberately generous: canonical id, the stored
    // User.userID (E-format, A-format matric or null) AND the legacy key. A row
    // under a non-NUS user's legacy key is already counted in [2] as THEIR data
    // and must not be re-reported here as junk.
    const live = new Set();
    for (const u of users) {
      for (const k of [canonicalUserID(u.email), String(u.userID ?? ""), legacyCanonicalUserID(u.email)]) {
        // C9: canonicalUserID may now be null, and this set is matched against
        // Bookings.userID values at :366 — a null must never become a member.
        // The `if (k)` truthiness guard already handles that (null is falsy,
        // exactly as "" was), so the behaviour here is UNCHANGED by C9 and the
        // line is deliberately left as it is. Flagged only because the obvious
        // "tidy-up" — hoisting to `live.add(k)` or `.filter(Boolean)`-free
        // spreading — would admit null, and `String(null)` elsewhere would make
        // it the string "null", a key that matches nothing and is reported as a
        // live user. Keep the guard.
        if (k) live.add(k);
      }
    }
    for (const g of grouped.rows) {
      const n = numify(g.n);
      const key = typeof g._id === "string" ? g._id : null;
      if (key === "") { emptyRows += n; continue; }
      if (key !== null && (E_FORMAT.test(key) || live.has(key))) continue;
      junk.push(`${keyLabel(g._id)}(${n})`);
      junkRows += n;
    }
  }
  stat("Bookings keyed on \"\" (written since the merge)", emptyRows,
    emptyRows ? "each is unattributable AND collides in the userDict join" : "");
  stat("other keys matching no E-format id, no live user", junk.length,
    junkRows ? `${junkRows} rows` : "");
  if (junk.length) console.log(`      ${sample(junk)}`);

  // --- (4) key-format census for the droplet-owned collections ----------
  console.log(`\n--- [4] key-format census, droplet-owned collections (08 §2d) ---`);
  let anyNonE = false;
  for (const coll of DROPLET_OWNED) {
    const g = await aggregateAll(db, coll, [{ $group: { _id: "$userID", n: { $sum: 1 } } }]);
    if (!g.ok) { unreadable.push(`${coll} (group): ${g.errmsg}`); console.log(`  ${coll.padEnd(14)} UNREADABLE — ${g.errmsg}`); continue; }
    const buckets = new Map();
    for (const row of g.rows) {
      const b = bucketOf(row._id);
      const e = buckets.get(b) ?? { keys: [], rows: 0 };
      e.keys.push(keyLabel(row._id));
      e.rows += numify(row.n);
      buckets.set(b, e);
    }
    const parts = [...buckets].map(([b, e]) => `${b}:${e.keys.length}k/${e.rows}r`);
    console.log(`  ${coll.padEnd(14)} ${parts.join("  ") || "(empty collection)"}`);
    for (const [b, e] of buckets) {
      if (b === "E-format") continue;
      anyNonE = true;
      console.log(`      ${b.padEnd(13)} ${sample(e.keys)}`);
    }
  }
  if (anyNonE) {
    console.log(`\n  CAVEAT (08 §2). Posts / UserCCA / Gym / Order / BookingLogs are written by`);
    console.log(`  the Python backends on the droplet, NOT by this repo. A non-E bucket above`);
    console.log(`  means at least one of them keys on something this codebase does not control.`);
    console.log(`  If any of it is the legacy email-ish value, remediation must be COORDINATED`);
    console.log(`  with those services first — that is a scope expansion, not a detail.`);
  }

  if (unreadable.length) {
    console.log(`\n  COMMANDS THAT FAILED (NOT measured zeroes — resolve before deciding):`);
    for (const u of unreadable) console.log(`      ${u}`);
  }

  // --- verdict ----------------------------------------------------------
  console.log(`\n================================`);
  console.log(`08 §3 branch indicators — the CHOICE IS THE OPERATOR'S, not this script's.`);
  console.log(`  non-NUS users ............ ${nonNus.length}`);
  console.log(`  of those, owning data .... ${owners.length}`);
  console.log(`  ""-keyed Bookings ........ ${emptyRows}`);
  console.log(`  other unattributable ..... ${junkRows} rows / ${junk.length} keys`);
  console.log(``);
  // A branch recommendation printed over a failed read is worse than no
  // recommendation: the operator records the zero in 08 §3 and unblocks the
  // off -> permissive -> enforce flip, which turns the silent emptiness into a
  // hard sign-in denial for the population that was never counted. If ANY
  // command failed, the numbers above are a partial census and no branch
  // follows from them.
  if (unreadable.length) {
    console.log(`NO BRANCH VERDICT. ${unreadable.length} command(s) failed (listed above), so the`);
    console.log(`counts above are a PARTIAL census, not a measurement. Do NOT record any of them`);
    console.log(`in 08 §3 and do NOT move the auth switch off "off". Resolve the failures — most`);
    console.log(`likely a missing read privilege or a collection absent on this cluster — and`);
    console.log(`re-run until this section prints a branch.`);
  } else if (!nonNus.length) {
    console.log(`Consistent with BRANCH A (empty). No account is affected, so no re-key is`);
    console.log(`warranted. Keep §1 regardless — it closes the hazard permanently. Record this`);
    console.log(`zero, WITH TODAY'S DATE, in 08 §3 before the auth switch moves off "off".`);
  } else if (!owners.length) {
    console.log(`Consistent with BRANCH B (accounts exist, none owns data). Deleting them is`);
    console.log(`plausible — but this script cannot tell a junk account from a real person who`);
    console.log(`has simply never booked. Read the addresses above and decide. If you delete:`);
    console.log(`read cascade.ts first (07 §5 — an orphaned UserRole is inherited by a later`);
    console.log(`account re-created from the same email) and back up first.`);
  } else {
    console.log(`Consistent with BRANCH C (real people with real data) for ${owners.length} account(s):`);
    for (const o of owners) console.log(`      ${o.email}  ${o.total} rows  [${o.hits.join(" ")}]`);
    console.log(`Branch C is warranted ONLY for someone with no NUS address at all. If any of`);
    console.log(`the above also has one, merge-accounts.mjs is the cheaper answer. A re-key`);
    console.log(`needs the AuthAllowlist / EXT: contradiction resolved first (08 §3 Branch C).`);
  }
  if (emptyRows) {
    console.log(`\n${emptyRows} ""-keyed Bookings exist REGARDLESS of the branch: they are`);
    console.log(`unattributable and they collide with each other in the userDict join. They must`);
    console.log(`be cleaned or attributed under every branch (08 "Done when").`);
  }
  console.log(`\nThis mode wrote nothing.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
