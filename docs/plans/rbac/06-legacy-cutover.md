> **Decision D-6 (binding): FULL transition. The legacy scalar fields `UserRole.role` and `FacilityAccess.requiredRole` ARE dropped.** v1's "keep the mirror indefinitely" recommendation (`01-data-model.md:494-509`, `00-overview.md:97`, `05-verification.md:195-198`) is overridden. This document replaces `01-data-model.md` Step 12 wholesale.
>
> This is the **only irreversible operation in the entire RBAC plan.** Everything below is machinery for proving the drop is lossless, then acting on it, then being able to recover if it was not.

---

## 0. The predicate the whole document is built on

The drop is safe **iff the legacy scalar carries no information that is not already in the array.** Per document:

```
UserRole:        role         is absent/null/""  OR  role         ∈ roles
FacilityAccess:  requiredRole is absent/null/""  OR  requiredRole ∈ requiredRoles
```

**This is CONTAINMENT, not equality.** v1's dual-write invariant is `role === legacyMirror(roles)` (`01-data-model.md:307-309`, `02-backend-authz.md:31-38`). Do **not** reuse that as the gate — under D-1 it produces false failures that will stall the cutover indefinitely:

- The resident backfill (`01-data-model.md` Step 12 — "Materialize `resident`") creates ~504 `UserRole` documents whose only role is `resident`. `PRECEDENCE = ["admin","jcrc","cca_head"]` (`02-backend-authz.md:26`) does not contain `resident`, so `legacyMirror(["resident"])` is `null`. Equality fails on ~504 rows forever.
- Containment is exactly the property that makes deletion lossless: if the scalar is empty, deleting it destroys nothing; if it is contained in the array, the array already carries it.

Keep the equality rule as a **warn-only diagnostic** in the verifier — it catches genuine dual-write regressions (e.g. `roles[0]` creeping back in) — but gate only on containment.

### 0.1 `resident` is NEVER written to either legacy scalar — on BOTH sides

**Decision: `PRECEDENCE` stays `["admin","jcrc","cca_head"]`. `resident` is never mirrored into `UserRole.role`, and never into `FacilityAccess.requiredRole`.**

**This is unchanged by the revised I-8 (`resident` STORED, auto-assigned, self-healing rather than derived).** Storing `resident` in `UserRole.roles` changes what the *array* contains — it is now a real value on every eligible row, ~515 of them, including every admin's — but it changes nothing about `PRECEDENCE`, which still excludes it, and therefore nothing about either mirror. `legacyMirror(["resident","admin"])` is still `"admin"`; `legacyMirror(["resident"])` is still `null`. The whole of §0.1 below reads identically under the stored design; only the reason the array contains `resident` has changed.

The `UserRole` half is a rollback-safety argument, not an aesthetic one. The legacy scalar exists solely so a revert of the Phase-2 code keeps working. Pre-v2 `src/server/api/services/access.ts:36-39` is `if (!required) return true` — default-**open**. In that world `resident` is meaningless. Writing `role: "resident"` writes a value the only consumer cannot interpret, and would displace a real value for a user holding `["resident","cca_head"]`.

**The `FacilityAccess` half is the one that is easy to get wrong and is a total-lockout bug.** v1's dual-write for facilities is `requiredRole: roles[0]` (`02-backend-authz.md:903-904`). Under D-1 every normal room gets `requiredRoles: ["resident"]`, so `roles[0]` writes `requiredRole: "resident"`. Now revert Phase 2:

1. Reverted `access.ts:27` reads `requiredRole` → `"resident"`.
2. Reverted `access.ts:19` reads `getUserRole` → `row?.role ?? DEFAULT_ROLE` → `"user"` for every resident, because §0.1 correctly forbids mirroring `resident` into `UserRole.role`.
3. `role === required` is false, caller is not admin → `canBookFacility` returns **false for every normal room, for every non-admin.**

The revert that the dual-write exists to make safe becomes a total booking lockout — strictly worse than not reverting. **And the containment gate cannot catch it**: `"resident"` IS contained in `["resident"]`, so B2 passes green.

Therefore, three mandatory changes owned by this document:

1. `02-backend-authz.md:903-904` — `setFacilityAccess` writes `requiredRole: legacyMirror(requiredRoles)` (PRECEDENCE-filtered, yielding `null` for a resident-only room), **not** `roles[0]`.
2. `01-data-model.md` / the D-1 facility seed — writes the same PRECEDENCE-filtered mirror. A resident-only facility gets no legacy scalar at all.
3. **Blocking check B2b** in the verifier (§3): any `FacilityAccess` row with `requiredRole === "resident"` fails the gate. Step 1 of §5 runs a one-time `$unset` sweep to clear any that were written before the fix landed.

### 0.2 Consequence to record in `01-data-model.md`

Once the resident backfill has run, **the legacy mirror is no longer a complete representation of role state** — and under the stored baseline that incompleteness is now *universal*, not partial: **every** eligible row carries a `resident` the mirror does not and must not express, admins included. **And the "revert Phase 2" row in `05-verification.md:195` is a revert of RBAC v2 *including* D-1 default-deny — not a partial revert.** That is fine (reverting `access.ts` reverts default-deny in the same commit), but it must be written down. Nobody should discover it during an incident.

---

## 1. Hard precondition: the legacy scalars MUST already be nullable

`prisma/schema.prisma:244-256` today is:

```prisma
model UserRole {
  userID String @unique
  role   String            // REQUIRED, non-nullable
}
model FacilityAccess {
  facilityID   Int    @unique
  requiredRole String            // REQUIRED, non-nullable
}
```

Under invariant I-2, Prisma 6's Mongo connector **throws on read** when a required non-list scalar is absent from a document. The resident backfill creates ~504 `UserRole` documents with no `role`; the D-1 facility seed creates a `FacilityAccess` row per facility with no `requiredRole`. Both reads sit on hot paths (`src/server/auth.ts` session callback; `src/server/api/routers/facilitiesBooking.ts:130`, `:319`, `:383`).

**`01-data-model.md`'s Phase-1 `db push` MUST relax both to `String?` in the same push that adds `roles String[]` / `requiredRoles String[]`.** This is a read-side-only Prisma change: it writes nothing and touches no `$jsonSchema` (both collections are unvalidated). It is the standard D-6 posture — optional first, drop later.

This document **refuses to proceed** if that has not happened. §5 step 0 asserts it.

---

## 2. Sequencing against the resident backfill

The two migrations touch `UserRole` with opposite intent: the resident backfill **creates ~504 documents**; the legacy drop **removes a field from all documents**. The bad interleavings are concrete:

| Interleaving | Failure |
|---|---|
| Drop first, resident backfill second | Mongo is schemaless — a copy-paste of the seed's `legacyMirror()` line silently re-creates the field on 504 documents after you "proved" it was gone. |
| Drop *during* the resident backfill | The `multi: true` `$unset` races the inserts. Documents inserted after the cursor passes retain `role`. Post-drop verification then fails, or worse, passes because it ran before the backfill finished. |
| **Drop while dual-writing code is still deployed** | **The genuinely dangerous one.** `setUserRoles` (`02-backend-authz.md:568-575`), `setFacilityAccess` (`02:903-904`), the I-8b baseline writer `ensureBaseline` and the D-8 pending-grant redemption all write on every mutation/session. Any one of them re-creates the field after the `$unset`. You are then in a permanently mixed state that no single verification run detects. |

**Rule: the resident backfill and the legacy drop are separated by the whole of the dual-write window. They never overlap.**

**Correction the revised I-8 forces on that diagram.** It is no longer true that *all* `UserRole` document creation happens in Phase 1b. `ensureBaseline` (I-8b self-heal) inserts a `UserRole` document, on the session path, **for the rest of the application's life** — for every new account and for any row that goes missing. Phase 1b is therefore the *bulk* creation, not the last of it. Two consequences, both handled below and neither requiring a change to the ordering rule itself:

- The `$unset` still only has to outlive the *writers of the legacy field*, not the writers of documents. §5 step 4 removes `ensureBaseline`'s `$setOnInsert: { role: "" }`, after which its inserts carry no legacy field and are harmless.
- But a surviving `$setOnInsert` now resurrects the field **intermittently and indefinitely**, at a rate set by new-account creation rather than by login volume. That is why §5 step 6's +24h/+72h re-checks exist and why they are not optional.

```
Phase 1   (01-data-model)  backfill roles[]/requiredRoles[]  →  db push (incl. String? relax)  →  seed
Phase 1b  (01-data-model, Steps 11-12)  resident backfill + per-facility FacilityAccess rows
                                 ← BULK UserRole document creation happens here
Phase 2   (02-backend-authz)     code deploy: dual-write live, array is source of truth
Phase 3   (03-admin-dashboard)
Phase 4   (04-profile-page)
──────── dual-write window: soak, minimum 14 days (§3) ────────
Phase 5   (THIS DOC)             legacy drop  ← NO document creation, field removal only
```

`00-overview.md:90-97`'s phase table must gain Phase 1b, and Phase 5's "optional" becomes "**scheduled**".

**Non-negotiable ordering inside Phase 5: the code that writes the legacy field must be gone from production BEFORE the `$unset` runs.** v1 Step 12 has the schema edit and the `$unset` but **no deploy step at all** — that omission is the mixed-state bug above.

---

## 3. The dual-write window — when it ends

v1 never states an end. Two things bound it:

1. **The 30-day JWT.** `src/server/auth.ts:119` sets `session.maxAge` to 30 days. Roles are read live in the session callback (I-4), so revocation is unaffected — but the *population* exercising the new code path turns over on that clock. A user who has not logged in since the cutover has tested nothing.
2. **Booking cadence.** Under D-1 every normal room is `["resident"]`-gated. The lockout modes only surface when someone books.

**Minimum 14 days from the Phase-2 deploy, AND all four exit criteria met, whichever is later.**

| # | Exit criterion | How |
|---|---|---|
| E1 | ≥14 days since the Phase-2 deploy, no rollback of Phases 2–4 under consideration | calendar |
| E2 | `verify-legacy-drop.mjs` coverage section clean on **three consecutive daily runs** — both `facilities without an access row: 0` **and** `eligible users missing resident: 0` | §4 |
| E3 | ≥1 successful `set` from `/admin` since the Phase-2 deploy | `db.RoleAuditLog.countDocuments({ ok: true, action: "set" })` > 0 |
| E4 | ≥1 booking of a `["resident"]`-gated room by a **non-admin, non-jcrc resident** since the Phase-2 deploy | §3.1 — run the query, do not tick the box from memory |

E4 is the one that matters and the one that gets skipped. `canBookWithRoles` short-circuits `return true` for `admin` before consulting `requiredRoles` (`02-backend-authz.md:165`), so **an admin's own successful booking proves nothing.** The person running the rollout is the admin.

There is no cost to extending the window. A nullable field on two collections holding ~515 and ~12 documents is inert.

### 3.1 The E4 query, written out

`Bookings` has no role column, so this is a join through the canonical userID (`prisma/schema.prisma:100-117`; `Bookings.userID` is written from `session.user.userID`, i.e. E-format).

```js
// mongosh. PHASE2_TS = epoch SECONDS of the Phase-2 deploy (Bookings.startTime is Int).
const residentFacilities = db.FacilityAccess
  .find({ requiredRoles: "resident" }).map(f => f.facilityID);

const candidates = db.Bookings.find({
  startTime: { $gte: PHASE2_TS },
  facilityID: { $in: residentFacilities },
}).map(b => b.userID);

const proof = db.UserRole.find({
  userID: { $in: candidates },
  roles: "resident",
  role:  { $nin: ["admin", "jcrc"] },          // legacy scalar, still present here
  roles: { $nin: ["admin", "jcrc"] },
}).limit(5).toArray();

printjson(proof);   // must be NON-EMPTY. Record one userID in the checklist.
```

`verify-legacy-drop.mjs` prints this as a non-blocking diagnostic so the go/no-go reviewer sees an actual userID rather than a checkbox.

---

## 4. The gate — `scripts/remediation/verify-legacy-drop.mjs`

New file. Read-only, no `APPLY` flag. Exits **1** on any blocking failure.

Uses `$runCommandRaw` throughout for the same reason `backfill-roles-v2.mjs` does (`01-data-model.md:57-58`): a typed Prisma read of a document mid-migration can throw, and this script's entire job is to run against exactly that state.

### 4.1 Blocking vs. coverage — a deliberate separation

Two counters, never summed:

- **`blocking`** — B1, B2, B2b, B5, B6. These are *losslessness and safety* properties. Non-zero ⇒ the `$unset` would destroy information or leave unreviewed privilege. Hard stop.
- **`coverage`** — C1, C2. These are *D-1 rollout health* properties. They belong here because this is the last gate before an irreversible step and therefore the highest-leverage place to run them — but a missing baseline is not a reason the *drop* is unsafe. Reported under their own heading, feeding checklist item E2, judged by a human.

This separation is load-bearing, and the revised I-8 (`resident` STORED rather than derived) sharpens **why** rather than removing the need for it:

- **The old reason is now wrong and must not be quoted.** Under derivation, a dormant account could never hold `resident` because materialization only happened at login, so C2 could never legitimately reach zero. That is no longer true: the backfill is now **authoritative** and grants the stored baseline to every eligible `User` row regardless of whether it has ever signed in. **Dormancy is no longer an excuse for a non-zero C2.** A non-zero C2 means the backfill missed someone or a grant point (I-8a) is broken — a real signal, which is exactly why E2 demands three consecutive clean daily runs.
- **The reason it still is not `blocking`** is that a missing baseline is *repairable and self-repairing* (I-8b: `ensureBaseline` tops it up at the offender's next session read, before any authoritative check consumes it), whereas B1/B2/B2b failures are *losslessness* failures that the `$unset` would make permanent. Coverage is a live-lockout signal; blocking is an irreversibility signal. They answer different questions and must never be summed.
- The non-NUS half of the old parenthetical stands unchanged: a non-NUS account can never hold `resident` (I-8d), which is why C2's population is already restricted to canonicalizable `@u.nus.edu` rows.

The realistic outcome of an unpassable gate remains that the operator comments out the check — deleting the only detector for the highest-risk lockout in the revision.

### 4.2 The script

```js
/**
 * D-6 gate: prove the legacy scalar `role` / `requiredRole` carries no
 * information not already present in `roles` / `requiredRoles`, so that
 * dropping it is lossless.
 *
 *   node scripts/remediation/verify-legacy-drop.mjs
 *
 * Read-only. Exit 0 = drop is permitted, and a pass-marker is written to
 * backups/gate-pass-<ISO>.json for drop-legacy-role-fields.mjs to consume.
 * Exit 1 = DO NOT DROP.
 *
 * VALIDITY WINDOW: run this WHILE THE DUAL-WRITE IS STILL DEPLOYED (i.e.
 * before step 5c). After the dual-write is removed, a legitimately-edited
 * document carries a STALE-but-harmless scalar and B2 reports a false
 * failure. See section 4.5. Do NOT re-run this as a gate post-5c.
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const db = new PrismaClient();
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

/** Drain a raw cursor fully. `batchSize` is a request, not a guarantee. */
async function findAll(collection, projection = {}) {
  const out = [];
  let res = await raw({ find: collection, filter: {}, projection, batchSize: 1000 });
  out.push(...(res?.cursor?.firstBatch ?? []));
  let id = res?.cursor?.id;
  while (id && String(id) !== "0") {
    res = await raw({ getMore: id, collection, batchSize: 1000 });
    out.push(...(res?.cursor?.nextBatch ?? []));
    id = res?.cursor?.id;
  }
  return out;
}

/** Aggregation-based count. The `count` command is deprecated on MongoDB 5.0+
 *  and documented as potentially inaccurate — unacceptable for the gate on the
 *  one irreversible operation in the plan. */
async function countWhere(collection, filter) {
  const r = await raw({
    aggregate: collection,
    pipeline: [{ $match: filter }, { $count: "n" }],
    cursor: {},
  });
  return Number(r?.cursor?.firstBatch?.[0]?.n ?? 0);
}

const PRECEDENCE = ["admin", "jcrc", "cca_head"];      // NOT "resident" — section 0.1
const legacyMirror = (roles) => PRECEDENCE.find((r) => roles.includes(r)) ?? null;
const empty = (v) => v === null || v === undefined || v === "";

/** Canonical userID. MUST byte-match src/lib/identity.ts (owned by 02-backend-authz.md §2.1).
 *  Anchored; returns "" for anything that is not a valid @u.nus.edu address. */
const NUS = /^([A-Z0-9._%-]+)@U\.NUS\.EDU$/;
const canonical = (e) => { const m = NUS.exec(String(e ?? "").trim().toUpperCase()); return m ? m[1] : ""; };

const blocking = [];
const coverage = [];

// ---------- B1 / B2 / W1: containment ----------
function auditContainment({ label, docs, key, arrayKey, scalarKey }) {
  const warnings = [];
  let withScalar = 0;
  for (const d of docs) {
    const arr = Array.isArray(d[arrayKey]) ? d[arrayKey] : null;

    // B1: the array must EXIST and be an array on every document. A missing
    //     array means the Phase-1 backfill did not cover this document, so the
    //     scalar is the ONLY role data it has and dropping it destroys it.
    if (arr === null) { blocking.push(`${label} ${d[key]}: ${arrayKey} missing or not an array`); continue; }

    const scalar = d[scalarKey];
    if (empty(scalar)) continue;
    withScalar++;

    // B2: CONTAINMENT. This is the gate.
    if (!arr.includes(scalar)) {
      blocking.push(`${label} ${d[key]}: ${scalarKey}=${JSON.stringify(scalar)} NOT in ${arrayKey}=${JSON.stringify(arr)}`);
      continue;
    }

    // W1: warn-only equality with the dual-write rule. A stale-but-contained
    //     scalar is still lossless to delete; this flags a dual-write regression.
    if (arrayKey === "roles" && scalar !== legacyMirror(arr)) {
      warnings.push(`${label} ${d[key]}: ${scalarKey}=${scalar} but legacyMirror=${legacyMirror(arr)} (dual-write drift)`);
    }
  }
  console.log(`\n--- ${label} containment ---`);
  console.log(`documents:              ${docs.length}`);
  console.log(`carrying legacy scalar: ${withScalar}`);
  console.log(`warnings:               ${warnings.length}`);
  for (const w of warnings) console.warn(`  warn   ${w}`);
}

async function main() {
  const userRole       = await findAll("UserRole");
  const facilityAccess = await findAll("FacilityAccess");

  auditContainment({ label: "UserRole",       docs: userRole,       key: "userID",     arrayKey: "roles",         scalarKey: "role" });
  auditContainment({ label: "FacilityAccess", docs: facilityAccess, key: "facilityID", arrayKey: "requiredRoles", scalarKey: "requiredRole" });

  // ---------- B2b: the resident mirror trap (section 0.1) ----------
  const residentMirrored = facilityAccess.filter((f) => f.requiredRole === "resident");
  for (const f of residentMirrored) {
    blocking.push(`FacilityAccess ${f.facilityID}: requiredRole="resident" — a Phase-2 revert would DENY this room to every non-admin. Unset it (see 06 section 5 step 1).`);
  }

  // ---------- B5: duplicate keys ----------
  // @unique is only enforced if the index actually built, and this repo has a
  // live history of dual-identity duplicate accounts (merge-accounts.mjs,
  // dedupe-users.mjs, commits 568c51c / fe9afe8). With duplicates, findUnique
  // returns one arbitrarily, containment passes on whichever copies happen to
  // be consistent, and a divergent second copy is never reviewed.
  for (const [coll, k] of [["UserRole", "userID"], ["FacilityAccess", "facilityID"]]) {
    const r = await raw({ aggregate: coll, cursor: {}, pipeline: [
      { $group: { _id: `$${k}`, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }] });
    for (const d of r?.cursor?.firstBatch ?? []) blocking.push(`${coll}: duplicate ${k}=${d._id} (${d.n} rows) — @unique index did not build`);
  }

  // ---------- B6: unexercised deferred privilege ----------
  // PendingRoleGrant (06-bulk-ops / 02) is a THIRD repository of privilege that
  // survives the cutover. An outstanding deferred admin/jcrc grant redeemed
  // AFTER the drop is a privilege change nobody at the go/no-go gate ever saw.
  let pending = [];
  try { pending = await findAll("PendingRoleGrant"); } catch { /* collection may not exist yet */ }
  const nowMs = Date.now();
  const livePriv = pending.filter((p) =>
    (p.roles ?? []).some((r) => r === "admin" || r === "jcrc") &&
    (!p.expiresAt || new Date(p.expiresAt).getTime() > nowMs));
  for (const p of livePriv) {
    blocking.push(`PendingRoleGrant ${p.userID}: outstanding ${JSON.stringify(p.roles)} created by ${p.createdBy} — requires named sign-off or revocation before the drop`);
  }
  console.log(`\n--- deferred grants ---`);
  console.log(`PendingRoleGrant rows:  ${pending.length}`);
  console.log(`live admin/jcrc grants: ${livePriv.length}`);

  // ---------- C1 (coverage): every facility has an access row ----------
  const facilities = await findAll("Facilities", { facilityID: 1, facilityName: 1 });
  const gated = new Set(facilityAccess.map((f) => f.facilityID));
  const unconfigured = facilities.filter((f) => f.facilityID !== -1 && !gated.has(f.facilityID));
  console.log(`\n--- C1 facility coverage ---`);
  console.log(`Facilities (excl. -1 sentinel): ${facilities.length}`);
  console.log(`without a FacilityAccess row:   ${unconfigured.length}`);
  for (const f of unconfigured) {
    coverage.push(`facilityID ${f.facilityID} (${f.facilityName}) has NO FacilityAccess row`);
    console.warn(`  COVERAGE  facilityID ${f.facilityID} (${f.facilityName})`);
  }

  // ---------- C2 (coverage): stored-baseline coverage ----------
  // Under the revised I-8, `resident` is STORED, so this counts real rows, not
  // a materialization lag. Population is restricted to accounts the auto-grant
  // can actually reach: an anchored @u.nus.edu email, deduplicated by canonical
  // id. Non-NUS rows CANNOT hold resident by design (D-7 / I-8d) and are
  // reported separately — counting them would make this check permanently
  // non-zero and therefore ignored (I-16 corollary).
  // This is the same computation as backfill-resident.mjs's VERIFY pass and
  // rbac-doctor.mjs's red line; all three must use the same predicate (I-12)
  // and none may test /^E\d{7}$/ (L-27: G.S_SAMUEL is a real eligible id).
  const users = await findAll("User", { email: 1 });
  const eligible = new Set();
  let nonNus = 0, blankEmail = 0, collapsed = 0;
  for (const u of users) {
    const id = canonical(u.email);
    if (!id) { if (String(u.email ?? "").trim()) nonNus++; else blankEmail++; continue; }
    if (eligible.has(id)) collapsed++;
    eligible.add(id);
  }
  const withResident = new Set(userRole.filter((r) => Array.isArray(r.roles) && r.roles.includes("resident")).map((r) => r.userID));
  const missing = [...eligible].filter((id) => !withResident.has(id));
  // Inverse: resident held by an id with no eligible NUS account behind it.
  const unbacked = [...withResident].filter((id) => !eligible.has(id));

  console.log(`\n--- C2 resident coverage ---`);
  console.log(`User documents:                  ${users.length}`);
  console.log(`  non-NUS (cannot sign in, D-7): ${nonNus}   [informational]`);
  console.log(`  blank email:                   ${blankEmail} [informational]`);
  console.log(`  duplicate canonical ids:       ${collapsed} [informational]`);
  console.log(`ELIGIBLE (distinct canonical):   ${eligible.size}`);
  console.log(`holding "resident":              ${withResident.size}`);
  console.log(`  MISSING resident:              ${missing.length}`);
  console.log(`  resident with NO NUS account:  ${unbacked.length}`);
  if (missing.length)  { coverage.push(`${missing.length} eligible users missing resident`);  console.warn(`  first 20 missing: ${missing.slice(0, 20).join(", ")}`); }
  if (unbacked.length) { blocking.push(`${unbacked.length} userID(s) hold "resident" with no eligible @u.nus.edu account: ${unbacked.slice(0, 10).join(", ")}`); }

  // ---------- D1 (diagnostic): role vocabulary ----------
  // roles[] lives in a collection with no $jsonSchema validator; nothing else
  // constrains what strings land there.
  const VOCAB = new Set(["admin", "jcrc", "cca_head", "resident"]);
  const strays = new Set();
  for (const r of userRole) for (const s of r.roles ?? []) if (!VOCAB.has(s)) strays.add(s);
  console.log(`\n--- D1 role vocabulary ---`);
  console.log(`out-of-vocabulary role strings: ${strays.size} ${strays.size ? JSON.stringify([...strays]) : ""}`);
  if (strays.size) blocking.push(`out-of-vocabulary role strings present: ${JSON.stringify([...strays])}`);

  // ---------- E4 (diagnostic): non-admin resident booking ----------
  console.log(`\n--- E4 non-admin resident booking (run the section 3.1 query manually) ---`);

  // ---------- verdict ----------
  console.log(`\n================================`);
  console.log(`BLOCKING failures: ${blocking.length}`);
  for (const b of blocking) console.error(`  BLOCK     ${b}`);
  console.log(`COVERAGE issues:   ${coverage.length}  (feeds go/no-go item E2, not a hard block)`);

  if (blocking.length) {
    console.error(`\nGATE FAILED — DO NOT DROP.`);
    process.exitCode = 1;
    return;
  }
  // Pass-marker. drop-legacy-role-fields.mjs refuses to run without one whose
  // counts match the live counts at drop time.
  const marker = {
    at: new Date().toISOString(),
    counts: {
      userRole: userRole.length,
      facilityAccess: facilityAccess.length,
      userRoleWithScalar:       await countWhere("UserRole", { role: { $exists: true } }),
      facilityAccessWithScalar: await countWhere("FacilityAccess", { requiredRole: { $exists: true } }),
    },
    coverage: coverage.length,
  };
  mkdirSync(join(HERE, "backups"), { recursive: true });
  const p = join(HERE, "backups", `gate-pass-${marker.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(p, JSON.stringify(marker, null, 2));
  console.log(`\nGATE PASSED — the legacy drop is permitted.`);
  console.log(`Pass-marker: ${p}`);
  if (coverage.length) console.warn(`NOTE: ${coverage.length} coverage issue(s) — review before the go/no-go checklist.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
```

### 4.3 Equivalent `mongosh` one-liners

For a quick check without the script. Both must return **0**.

```js
// UserRole. The $isArray guard is load-bearing: the aggregation `$in` operator
// ERRORS (rather than returning false) when its second argument is not an
// array, which is exactly the malformed shape branch 2 exists to detect.
db.UserRole.countDocuments({ $or: [
  { roles: { $exists: false } },
  { roles: { $not: { $type: "array" } } },
  { $and: [
      { role: { $exists: true } }, { role: { $nin: [null, ""] } },
      { $expr: { $cond: [ { $isArray: "$roles" }, { $not: [ { $in: ["$role", "$roles"] } ] }, true ] } },
  ]},
]})

// FacilityAccess — same shape, plus the section 0.1 resident-mirror trap.
db.FacilityAccess.countDocuments({ $or: [
  { requiredRoles: { $exists: false } },
  { requiredRoles: { $not: { $type: "array" } } },
  { requiredRole: "resident" },
  { $and: [
      { requiredRole: { $exists: true } }, { requiredRole: { $nin: [null, ""] } },
      { $expr: { $cond: [ { $isArray: "$requiredRoles" }, { $not: [ { $in: ["$requiredRole", "$requiredRoles"] } ] }, true ] } },
  ]},
]})
```

This **replaces** `05-verification.md:41-42`, which checks only `{ roles: { $exists: false } }` — a *presence* check that passes on a document with `roles: []` and `role: "admin"`, i.e. precisely the document whose scalar must not be dropped.

### 4.4 What each blocking class means when it fires

| Output | Cause | Fix |
|---|---|---|
| `roles missing or not an array` | Phase-1 backfill missed this document, or a later writer created it without the array | Re-run `backfill-roles-v2.mjs`; it is idempotent (`01-data-model.md:104-108`) |
| `role=X NOT in roles=[...]` | Genuine divergence — a dual-write path was missed, or someone hand-edited in Atlas | **Investigate; do not blind-fix.** Determine which side is correct. If the array is right, `$unset` that one document and re-run. If the *scalar* is right, the array is wrong and the drop would cause a live privilege change |
| `requiredRole="resident"` | §0.1 — the `roles[0]` mirror was live when this row was written | §5 step 1's sweep, then confirm `setFacilityAccess` uses `legacyMirror`, not `roles[0]` |
| `duplicate userID/facilityID` | The `@unique` index did not build | Dedupe (see `merge-accounts.mjs` precedent), then confirm via `db.UserRole.getIndexes()` |
| `outstanding admin/jcrc PendingRoleGrant` | Unexercised deferred privilege | Revoke it, or obtain named sign-off and record the name in the checklist |
| `resident with NO NUS account` | A grant keyed on a non-canonical id (I-1 violation), or a write that reached the baseline without provenance (I-8d violation), or a D-7 gap | Trace the id and the writer; do not proceed. Under the stored baseline this is a persisted grant, not a transient derivation, so it does not clear itself |
| `out-of-vocabulary role string` | Script or hand-edit wrote a string outside the vocabulary | Identify the writer before removing the string |

### 4.5 The gate's validity window

The containment check is meaningful **only while the dual-write is deployed.** After step 5c, a legitimately-edited document carries a stale scalar — e.g. an admin demoted to jcrc has `roles: ["jcrc"], role: "admin"`. B2 fails, but the data is correct and the scalar is exactly the garbage being deleted.

**Run the gate before step 5c. Never re-run it as a gate after.** Post-`$unset` verification is a different, simpler set of queries (§5 step 6). This is stated in the script header so nobody re-runs it in a panic and concludes the migration corrupted data.

---

## 5. The cutover — ordered

Steps 0–4 are ordinary reversible deploys. Steps 5–6 are the one-way door.

### Step 0 — Assert preconditions (5 minutes)

```bash
# 0a. The legacy scalars MUST already be nullable (section 1).
grep -nE '^\s+(role|requiredRole)\s+String' prisma/schema.prisma
#     MUST show `String?` on both. If it shows `String`, STOP — go back to
#     01-data-model.md Phase 1 and relax them. Everything downstream is unsafe.

# 0b. Backups directory is gitignored. VERIFIED at .gitignore:45
#     (`scripts/remediation/backups/`) and `git log --all -- ...` is empty,
#     so no dump is in history. Re-confirm before writing new dumps:
git check-ignore -v scripts/remediation/backups/
git log --all --oneline -- scripts/remediation/backups/     # must be empty
```

### Step 1 — Clear any `requiredRole: "resident"` (section 0.1)

Run this **at the start of the window**, not at the end, so the fix has soaked.

```js
// One-time sweep. Also fix the writer: 02-backend-authz.md:903-904 must use
// legacyMirror(requiredRoles), NOT roles[0].
await db.$runCommandRaw({ update: "FacilityAccess", updates: [
  { q: { requiredRole: "resident" }, u: { $unset: { requiredRole: "" } }, multi: true }]});
```

### Step 2 — Retire `seed-rbac.mjs` (do this EARLY, not at 5b)

`scripts/remediation/seed-rbac.mjs:28-32` and `:46-50` still upsert `{ userID, role }` / `{ facilityID, requiredRole }` with **no** `roles` array, and the SUPERSEDED guard described at `01-data-model.md:255-273` **is not in the file on disk today.** One run of it during the window creates a roles-less document; after step 3 that user reads as zero roles and silently loses `admin` or `jcrc` — and the gate has already passed, so nothing catches it.

**It also carries logic nothing else does.** `seed-rbac.mjs:55-66` seeds the `Counter` document for `bookingID`:

```js
await db.counter.upsert({ where: { key: "bookingID" },
  create: { key: "bookingID", seq: last?.bookingID ?? 0 }, update: {} });
```

Grepping `01-data-model.md` for `bookingID`/`counter` returns nothing — `seed-roles-v2.mjs` does not carry it forward. Deleting the file blind loses the only record of how the booking-id counter is initialised.

Ordered:

1. Move the `Counter`/`bookingID` block into a new `scripts/remediation/seed-counters.mjs` (verbatim; it is already idempotent via `update: {}`).
2. Move the 11 hardcoded JCRC E-format ids from `seed-rbac.mjs:16-20` into `scripts/remediation/data/jcrc-users.json` per `01-data-model.md` Step 6 — that file is their only home in source.
3. `git rm scripts/remediation/seed-rbac.mjs`.

> **Doc conflict, resolve in favour of this document.** `01-data-model.md:274` says *"Do not delete the file"* and gives provenance as the reason. Under D-6 the provenance is preserved by steps 1–2 above and the file is a live hazard. `01-data-model.md:255-277` must be amended: *"delete rather than guard; provenance moved to `data/jcrc-users.json` and `seed-counters.mjs`."*

### Step 3 — Remove legacy READS (reversible deploy)

`02-backend-authz.md:588-590` promises a finite enumerable list. Here it is:

| File | Remove |
|---|---|
| `src/server/api/services/access.ts` | `getUserRoles`: `row.roles?.length ? row.roles : row.role ? [row.role] : []` → `effectiveRoles(userID, row?.roles)` (`02:126-136`) |
| `src/server/api/services/access.ts` | `getFacilityRequiredRoles`: drop the `row.requiredRole` fallback (`02:150-159`) |
| `src/server/api/services/access.ts` | `getBookableFacilityMap`: drop the per-row fallback (`02:190-193`) |
| `src/server/api/services/access.ts` | last-admin guard: `OR: [{ roles: { has: ADMIN_ROLE } }, { role: ADMIN_ROLE }]` → `{ roles: { has: ADMIN_ROLE } }` (`02:568`) |
| `src/server/auth.ts` | session callback: `roleRow?.roles?.length ? ... : roleRow?.role ? ... : []` → `effectiveRoles(...)` (`02:297-298`) |
| `src/server/api/routers/admin.ts` | `listUsers` role filter: `where: { OR: [{ roles: { has: role } }, { role }] }` → `{ roles: { has: role } }` (`02:671`) |
| `src/server/api/routers/admin.ts` | `listUsers` hydration + default branch — two `r.roles?.length ? ... : r.role ? ...` expressions (`02:700`, `02:729`) |
| `src/server/api/routers/admin.ts` | `getStats`: three `OR: [{ roles: { has } }, { role }]` counts (`02:753-755`) |
| `src/server/api/routers/admin.ts` | `previewBulkImport`: `(r.roles ?? []).includes(x) \|\| r.role === x` (`02:794`) |
| `src/server/api/routers/admin.ts` | `listFacilityAccess`: `a?.requiredRoles?.length ? ... : a?.requiredRole ? ...` (`02:874`) |
| `src/server/api/routers/admin.ts` | `setFacilityAccess`: the `before` computation's fallback (`02:892-893`) |

**The last-admin guard is the one to change with care.** Narrowing it while a legacy-only admin still exists makes that admin invisible to the count and permits removing the real last admin. The gate's B1 (array must exist on every document) is exactly the precondition that proves no legacy-only row remains — **so step 3 comes AFTER a passing gate run, not before.**

Reads and writes are removed in separate deploys so that if step 3 breaks something, the mirror is still being maintained and reverting step 3 alone is sufficient.

### Step 4 — Remove legacy WRITES (last redeploy-reversible step)

| File | Remove |
|---|---|
| `src/server/api/services/roles.ts` | `PRECEDENCE` and `legacyMirror()` (`02:31-38`) — now dead |
| `src/server/api/services/roleService.ts` | `applyRoleChange`'s role write: `role: legacyMirror(after)` (`02:574-575` — under the revised I-8c this is a single `$set` inside the `$pull`/`$addToSet` write, no longer a two-branch `create`/`update` upsert, and it carries **no** `$setOnInsert` on `role`; removing the `$set` key is the whole edit) |
| `src/server/api/routers/admin.ts` | `setFacilityAccess` upsert: the `requiredRole` mirror on both branches (`02:903-904`) |
| `src/server/api/services/baseline.ts` | **The I-8b self-heal writer, `ensureBaseline`** (renamed from `ensureBaselineRole`; under the revised I-8 it is the *authoritative* baseline writer, not an advisory materializer). Remove its `$setOnInsert: { role: "" }` — added in `02-backend-authz.md` Step 2.5 purely to satisfy the required scalar (the sentinel is the empty string, not `null`/`"user"`; see `01-data-model.md` §0.1). **Remove it in the same commit that drops the scalar, not later:** `ensureBaseline` is a permanent hot-path writer that survives the cutover, so a surviving `$setOnInsert` keeps resurrecting a dropped field indefinitely and defeats the containment gate's whole purpose. Until then it must NOT write anything else. Its `$addToSet: { roles: "resident" }` is **not** touched by this step — that is the live baseline and it stays |
| `src/server/api/services/loginGrants.ts` | **The D-8 pending-grant redemption writer.** Under the revised design its `UserRole` write is already `$addToSet`-shaped (I-13), so this removal targets **only** its `$setOnInsert: { role: "" }` and any `role` in a `$set`. Its `pendingCheckedAt` stamp stays |
| `scripts/remediation/seed-roles-v2.mjs` | `legacyMirror` import/definition and every write of `role` / `requiredRole` (`01:307-309`, `01:330-332`, `01:383`, `01:423-424`) |

**The last two rows are the ones v1 cannot have known about.** They fire on the **session/login path**, not on mutation, so nothing an operator does at the console triggers them. Precisely, under the revised I-8: `ensureBaseline` is invoked from the session callback on **every request**, but its `$setOnInsert` only writes when it actually *inserts* — i.e. for a `UserRole` document that does not yet exist. That makes the resurrection **low-rate and intermittent** rather than immediate, which is worse, not better: the drop script's after-count will print `0/0` because no such insert occurred in that millisecond, and the field then reappears days later on the next new or hand-deleted account. This is exactly the permanently-mixed state of §2 row 3, and it is why §5 step 6 mandates re-checks at **24h and 72h**, and why the `$setOnInsert` removal is scheduled in the same commit as the schema drop rather than "soon after".

Grep gate before merging step 4:

```bash
grep -rnE '\brole\s*:|\brequiredRole\b|legacyMirror|PRECEDENCE' \
  src/ scripts/ prisma/schema.prisma | grep -v node_modules
```
Reviewed by hand — JSX `role=` accessibility attributes will appear and are expected. **Deploy step 4 and proceed to step 5 within the same maintenance window.** Between them, dashboard edits leave a stale scalar (harmless — step 5 deletes it) but the gate must not be re-run (§4.5).

### Step 5 — Back up, then drop

#### 5a. Backup

```bash
node scripts/remediation/backup-role-collections.mjs
```

New file. `05-verification.md:198` says only "run a reverse backfill" with no script; `01-data-model.md:10-17`'s backup is taken **before the Phase-1 backfill** — far too early to restore a post-migration state, and it predates every dashboard role edit made during the entire window.

**Backs up four collections, not two.** `RoleAuditLog` especially: §6's stated worst-case recovery is "manual reconstruction of the role graph from `RoleAuditLog`", and that log is in no other backup.

```js
/**
 * D-6: full JSON snapshot immediately before the $unset.
 *   node scripts/remediation/backup-role-collections.mjs
 * Writes backups/pre-legacy-drop-<ISO>.json. Read-only against the database.
 *
 * Primary method (not mongodump) because it matches the existing convention
 * (merge-accounts.mjs, 01-data-model.md:88-95), needs no MongoDB Database
 * Tools install, and works from the Windows dev machine where mongodump is
 * very likely absent.
 */
const COLLECTIONS = ["UserRole", "FacilityAccess", "RoleAuditLog", "PendingRoleGrant"];
// ... findAll() drain loop identical to verify-legacy-drop.mjs ...
const data = {};
for (const c of COLLECTIONS) { try { data[c] = await findAll(c); } catch { data[c] = null; } }
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = join(HERE, "backups", `pre-legacy-drop-${stamp}.json`);
writeFileSync(path, JSON.stringify({
  at: new Date().toISOString(),
  note: "D-6 pre-$unset snapshot. Restore with restore-legacy-scalars.mjs.",
  counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v?.length ?? "ABSENT"])),
  withLegacyScalar: {
    UserRole:       (data.UserRole ?? []).filter((d) => d.role).length,
    FacilityAccess: (data.FacilityAccess ?? []).filter((d) => d.requiredRole).length,
  },
  ...data,
}, null, 2));
```

The printed counts are load-bearing: they are what step 6 must show as having gone to zero, and what the restore must put back.

**Secondary backup.** Take an Atlas snapshot too (Project → Clusters → **…** → *Take Snapshot Now*, label `pre-legacy-drop-<date>`). **Note: M0/M2/M5 shared-tier clusters have no on-demand snapshot capability at all** — in that case the JSON dump is the *sole* backup and §5c's restore is the actual recovery plan, not insurance. Determine the tier before the maintenance window, not during it.

If MongoDB Database Tools happen to be installed:
```bash
mongodump --uri "$DATABASE_URL" --collection UserRole       --out scripts/remediation/backups/pre-legacy-drop-bson
mongodump --uri "$DATABASE_URL" --collection FacilityAccess --out scripts/remediation/backups/pre-legacy-drop-bson
# Restore to a DIFFERENT collection name; inspect, then merge by hand. Never --drop.
mongorestore --uri "$DATABASE_URL" --nsFrom '<db>.UserRole' --nsTo '<db>.UserRole_restored' \
  scripts/remediation/backups/pre-legacy-drop-bson
```

#### 5b. Schema diff + push

```diff
 model UserRole {
   id        String    @id @default(auto()) @map("_id") @db.ObjectId
   userID    String    @unique
   roles     String[]  @default([])
-  role      String?   // LEGACY mirror. See 06-legacy-cutover.md.
   updatedAt DateTime?
   updatedBy String?
   @@index([roles], map: "roles_multikey")
 }
```
```diff
 model FacilityAccess {
   id            String    @id @default(auto()) @map("_id") @db.ObjectId
   facilityID    Int       @unique
   requiredRoles String[]  @default([])
-  requiredRole  String?   // LEGACY mirror.
   updatedAt     DateTime?
   updatedBy     String?
 }
```

Also delete the stale doc comments — `prisma/schema.prisma:250-251` still says *"facilityID with no row = open to all"*, which D-1 already inverted (owned by `01-data-model.md`, but it must not survive past this commit).

```bash
npx prisma db push && npx prisma generate && npx tsc --noEmit
```

`db push` on MongoDB removes the field from **Prisma's view only** — it does **not** remove it from the stored documents (`01-data-model.md:499-500` states this correctly). Hence 5c.

> A `--accept-data-loss` prompt here is **expected and correct** — it is the D-6 drop. This is the one place `01-data-model.md`'s "any prompt = stop" rule does not apply. Confirm the prompt names only `role` and `requiredRole`; anything else = stop.

#### 5c. The `$unset`

`scripts/remediation/drop-legacy-role-fields.mjs` — v1's fire-and-forget `$unset` (`01:502-507`) upgraded to the dry-run + pre-count + post-count convention every other script in this directory uses, with **enforced** preconditions.

```js
/**
 * D-6, IRREVERSIBLE: $unset the legacy `role` / `requiredRole` fields.
 *
 * ENFORCED PRECONDITIONS (the script refuses if any fails):
 *   P1. A gate-pass marker from verify-legacy-drop.mjs exists AND its recorded
 *       counts match the live counts now.
 *   P2. Containment (B1/B2/B2b) re-verified INLINE, right now. Cheap on ~525
 *       documents, and it is what catches a still-deployed dual-writer BEFORE
 *       the one-way door rather than after.
 *   P3. A pre-legacy-drop-*.json snapshot exists and is < 2h old.
 *
 *   node scripts/remediation/drop-legacy-role-fields.mjs                     # dry run
 *   APPLY=yes CONFIRM=drop-legacy node scripts/remediation/drop-legacy-role-fields.mjs
 */
const APPLY   = process.env.APPLY === "yes";
const CONFIRM = process.env.CONFIRM === "drop-legacy";
const MAX_SNAPSHOT_AGE_MS = 2 * 60 * 60 * 1000;

function abort(msg) { console.error(`*** ABORT: ${msg} ***`); process.exitCode = 1; }

async function main() {
  let files = [];
  try { files = readdirSync(join(HERE, "backups")); }
  catch { return abort("backups/ does not exist. Run backup-role-collections.mjs."); }

  // P1
  const markers = files.filter((f) => f.startsWith("gate-pass-")).sort();
  if (!markers.length) return abort("no gate-pass-*.json. Run verify-legacy-drop.mjs (while the dual-write is still deployed).");
  const marker = JSON.parse(readFileSync(join(HERE, "backups", markers.at(-1)), "utf8"));
  console.log(`Gate marker: ${markers.at(-1)}  (passed ${marker.at})`);

  // P3
  const snaps = files.filter((f) => f.startsWith("pre-legacy-drop-") && f.endsWith(".json"))
    .map((f) => ({ f, m: statSync(join(HERE, "backups", f)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (!snaps.length) return abort("no pre-legacy-drop-*.json. Run backup-role-collections.mjs.");
  const ageMin = Math.round((Date.now() - snaps[0].m) / 60000);
  console.log(`Snapshot: ${snaps[0].f}  (${ageMin} min old)`);
  if (Date.now() - snaps[0].m > MAX_SNAPSHOT_AGE_MS) {
    return abort(`snapshot is ${ageMin} min old (max 120). A stale snapshot misses every dashboard edit since it was taken, and it is the SOLE input to restore-legacy-scalars.mjs. Re-run backup-role-collections.mjs.`);
  }

  // P2 — inline containment + resident-mirror re-check
  const userRole = await findAll("UserRole"), facilityAccess = await findAll("FacilityAccess");
  const bad = [];
  for (const d of userRole) {
    if (!Array.isArray(d.roles)) bad.push(`UserRole ${d.userID}: roles not an array`);
    else if (d.role && !d.roles.includes(d.role)) bad.push(`UserRole ${d.userID}: role=${d.role} not in roles`);
  }
  for (const d of facilityAccess) {
    if (!Array.isArray(d.requiredRoles)) bad.push(`FacilityAccess ${d.facilityID}: requiredRoles not an array`);
    else if (d.requiredRole === "resident") bad.push(`FacilityAccess ${d.facilityID}: requiredRole="resident" (section 0.1)`);
    else if (d.requiredRole && !d.requiredRoles.includes(d.requiredRole)) bad.push(`FacilityAccess ${d.facilityID}: requiredRole=${d.requiredRole} not in requiredRoles`);
  }
  if (bad.length) { bad.forEach((b) => console.error(`  BLOCK  ${b}`)); return abort(`${bad.length} containment failure(s) RIGHT NOW.`); }

  const beforeUR = await countWhere("UserRole", { role: { $exists: true } });
  const beforeFA = await countWhere("FacilityAccess", { requiredRole: { $exists: true } });
  console.log(`\nBEFORE  UserRole.role: ${beforeUR}   FacilityAccess.requiredRole: ${beforeFA}`);
  console.log(`Gate recorded: ${marker.counts.userRoleWithScalar} / ${marker.counts.facilityAccessWithScalar}`);
  if (beforeUR > marker.counts.userRoleWithScalar || beforeFA > marker.counts.facilityAccessWithScalar) {
    return abort("live scalar count EXCEEDS the gate's recorded count — a writer is still dual-writing (step 4 not deployed?).");
  }

  if (!APPLY || !CONFIRM) {
    console.log("\nDRY RUN — nothing changed.");
    console.log("To apply: APPLY=yes CONFIRM=drop-legacy node scripts/remediation/drop-legacy-role-fields.mjs");
    return;
  }

  await raw({ update: "UserRole",       updates: [{ q: { role:         { $exists: true } }, u: { $unset: { role: "" } },         multi: true }] });
  await raw({ update: "FacilityAccess", updates: [{ q: { requiredRole: { $exists: true } }, u: { $unset: { requiredRole: "" } }, multi: true }] });

  const afterUR = await countWhere("UserRole", { role: { $exists: true } });
  const afterFA = await countWhere("FacilityAccess", { requiredRole: { $exists: true } });
  console.log(`AFTER   UserRole.role: ${afterUR}   FacilityAccess.requiredRole: ${afterFA}`);
  if (afterUR || afterFA) {
    return abort("INCOMPLETE — documents still carry the legacy field. A deployed writer is still dual-writing (step 4).");
  }
  console.log("\nLegacy fields removed. NOT reversible without the snapshot.");
  console.log("Re-run the step 6 counts at +24h and +72h — a login-path writer will not show up immediately.");
}
```

The double gate (`APPLY=yes` **and** `CONFIRM=drop-legacy`) is deliberately stricter than the `DRY_RUN=false` convention, matching `dedupe-users.mjs`'s own precedent of a second flag (`FORCE_UNSAFE_DELETE=yes`) for the genuinely destructive branch.

### Step 6 — Post-drop verification

```js
db.UserRole.countDocuments({ role: { $exists: true } })              // 0
db.FacilityAccess.countDocuments({ requiredRole: { $exists: true } })// 0
db.UserRole.countDocuments({ roles: { $exists: false } })            // 0
```

Then:
- Re-run only the **coverage** half of `verify-legacy-drop.mjs` (C1/C2) — still valid post-drop.
- Smoke-test as a **non-admin resident**: log in, book a normal room, confirm success. An admin test is worthless (`02-backend-authz.md:165` bypass).
- Smoke-test as admin: `/admin` loads, grant + revoke work, `RoleAuditLog` rows written.
- **Re-run the three counts at +24h and +72h.** Non-zero ⇒ a writer survived step 4 — most likely the session-path `ensureBaseline` or the pending-grant writer, whose `$setOnInsert` fires only when a `UserRole` document is newly *inserted* (a new account, or one whose row was hand-deleted and self-healed). Find it before doing anything else. `db.UserRole.find({ role: { $exists: true } }, { userID: 1 })` names the offenders — cross-check them against recent `User` creations to identify which writer.

---

## 6. Restore

### 6.1 The two rules that make restore safe

**Rule R1 — reconstruct the scalar from the LIVE array, never from the snapshot's scalar.**

A naive restore (`$set role` from `snapshot.role`, matched by `userID`) **re-grants privileges that were legitimately revoked after the snapshot.** Concretely: a user is admin at snapshot time; weeks later, post-drop, an admin demotes them (`roles` → `["jcrc"]`, no scalar exists because step 4 removed the dual-write); an incident triggers the Phase-2 revert; the naive restore writes `role: "admin"` back; reverted `access.ts:19` reads `row?.role` as the source of truth and grants full admin. **The recovery procedure would itself be a privilege-escalation vector** — and it is the procedure a stressed operator runs under time pressure.

The live `roles[]` array is by definition current and correct — §0's containment gate already proved it is authoritative. So: `role = legacyMirror(liveRoles)`. The snapshot is retained for **forensics only**.

**Rule R2 — a Phase-2 revert MUST keep the scalars nullable.**

The revert contemplated in an incident is a `git revert` of the Phase-2 range, which restores the on-disk pre-v2 `prisma/schema.prisma:244-256` where `role String` and `requiredRole String` are **required**. After Phase 1b there are ~504 resident-only `UserRole` documents that never had a `role` and that R1 correctly leaves without one (`legacyMirror(["resident"])` is `null`). Prisma 6 then throws on every read of those documents — invariant I-2 — and `getUserRole` is reached from `facilitiesBooking.ts:130`, `:319` and `:383`. **Every booking read throws for every user.**

**Never `git checkout <pre-v2> -- prisma/schema.prisma`.** Hand-edit the two models back to `role String?` / `requiredRole String?` and `npx prisma db push` **before** running the restore script.

### 6.2 `scripts/remediation/restore-legacy-scalars.mjs`

```js
/**
 * D-6 RESTORE: re-create the legacy `role` / `requiredRole` scalars so a
 * Phase-2 code revert has a valid mirror to read.
 *
 *   node scripts/remediation/restore-legacy-scalars.mjs                 # dry run
 *   APPLY=yes node scripts/remediation/restore-legacy-scalars.mjs
 *   node scripts/remediation/restore-legacy-scalars.mjs --forensics <snapshot.json>
 *
 * RULE R1: the scalar is reconstructed from the LIVE roles[] array via
 * legacyMirror(). It is NEVER copied from a snapshot — doing so would re-grant
 * roles revoked since the snapshot was taken. --forensics only DIFFS the live
 * state against a snapshot and prints; it never writes.
 *
 * PREREQUISITE (rule R2): prisma/schema.prisma must declare BOTH scalars as
 * `String?` and `npx prisma db push` must have been run. The script asserts it.
 *
 * Touches ONLY the two scalar fields. It never writes roles[] / requiredRoles[]
 * — those are the source of truth.
 */
const PRECEDENCE = ["admin", "jcrc", "cca_head"];   // NOT "resident" — section 0.1
const legacyMirror = (roles) => PRECEDENCE.find((r) => (roles ?? []).includes(r)) ?? null;

// R2 assertion.
const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
if (!/^\s+role\s+String\?/m.test(schema) || !/^\s+requiredRole\s+String\?/m.test(schema)) {
  console.error("*** ABORT (rule R2): prisma/schema.prisma must declare `role String?` and " +
    "`requiredRole String?` and be pushed BEFORE restoring. Required scalars + the ~504 " +
    "resident-only documents = Prisma throws on every role read (invariant I-2). ***");
  process.exit(1);
}

for (const d of await findAll("UserRole")) {
  const mirror = legacyMirror(d.roles);
  if (!mirror) continue;                               // resident-only: correctly no scalar
  console.log(`  ${APPLY ? "+" : "~"} UserRole ${d.userID}: role -> ${mirror}  (from live roles=${JSON.stringify(d.roles)})`);
  if (APPLY) await raw({ update: "UserRole", updates: [{ q: { userID: d.userID }, u: { $set: { role: mirror } } }] });
}
for (const d of await findAll("FacilityAccess")) {
  const mirror = legacyMirror(d.requiredRoles);        // resident-only -> null -> skip (section 0.1)
  if (!mirror) continue;
  console.log(`  ${APPLY ? "+" : "~"} FacilityAccess ${d.facilityID}: requiredRole -> ${mirror}`);
  if (APPLY) await raw({ update: "FacilityAccess", updates: [{ q: { facilityID: d.facilityID }, u: { $set: { requiredRole: mirror } } }] });
}
```

**Path resolution.** Every script in this plan is invoked from the repo root (`node scripts/remediation/...`). Any snapshot argument must therefore resolve against `process.cwd()` first, falling back to the script directory, and print the resolved absolute path before reading. A restore script that cannot find its input is an availability failure at exactly the worst moment.

### 6.3 What restore does NOT give back

**A restore of the mirror does not restore the pre-D-1 world.** Per §0.1, resident-only users and resident-only facilities correctly end up with **no** legacy scalar. Under a reverted, default-open `access.ts` that is exactly right (`if (!required) return true`). But it means the reverted system has no concept of `resident` at all — reverting the mirror is only coherent as part of reverting D-1 default-deny in the same commit. Do not attempt a partial revert.

**One thing the stored baseline does make easier, and it should be said here so nobody deletes it in a panic.** Under the revised I-8, `resident` is real data in `roles[]`, and a Phase-2 revert leaves it there, **inert**: reverted `access.ts` reads only `role` / `requiredRole` and never looks at the arrays. So a revert requires **no cleanup of `roles[]`**, and re-applying Phase 2 afterwards requires **no re-run of the resident backfill** — the ~515 stored baselines survive the whole round trip untouched. Under derivation there was nothing to preserve; now there is, and the correct action is to preserve it by doing nothing. `restore-legacy-scalars.mjs` enforces this already (it "never writes `roles[]` / `requiredRoles[]`" — §6.2 header); that line is now protecting real state, not just tidiness.

---

## 7. Go / no-go checklist

Every line checked by a human before `APPLY=yes CONFIRM=drop-legacy`. **If any box in the first four groups is unchecked, the answer is no-go.**

The cost of waiting is a nullable field on two collections holding ~515 and ~12 documents. The cost of proceeding wrongly is a manual reconstruction of the role graph from `RoleAuditLog`.

**Preconditions — schema & scripts**
- [ ] `prisma/schema.prisma` declares `role String?` and `requiredRole String?` (§5 step 0a)
- [ ] `.gitignore` still contains `scripts/remediation/backups/`; `git log --all -- scripts/remediation/backups/` is empty
- [ ] `seed-rbac.mjs` deleted; `Counter`/`bookingID` seed migrated to `seed-counters.mjs`; the 11 JCRC ids live in `data/jcrc-users.json` (§5 step 2)

**Preconditions — data**
- [ ] `node scripts/remediation/verify-legacy-drop.mjs` exits **0**, run **while the dual-write was still deployed**
- [ ] `BLOCKING failures: 0`
- [ ] W1 dual-write-drift warnings reviewed and each individually understood — not merely tolerated because they are non-blocking
- [ ] No `FacilityAccess` row has `requiredRole: "resident"` (§0.1 / B2b)
- [ ] Zero duplicate `UserRole.userID` / `FacilityAccess.facilityID`; `db.UserRole.getIndexes()` shows the unique index
- [ ] Zero outstanding `admin`/`jcrc` `PendingRoleGrant` rows, **or** each is named here with sign-off: `_______________`
- [ ] Coverage: `facilities without an access row: 0` and `eligible users missing resident: 0`, on **three consecutive daily runs** (E2). Under the stored baseline this really must be `0` — the backfill is authoritative and covers dormant accounts, so "they just haven't logged in" is **not** a valid explanation for a non-zero count (§4.1)
- [ ] Zero out-of-vocabulary role strings (D1)

**Preconditions — window**
- [ ] ≥14 days since the Phase-2 deploy (E1)
- [ ] No rollback of Phase 2, 3 or 4 under consideration
- [ ] ≥1 successful `set` from `/admin` since the Phase-2 deploy (E3)
- [ ] §3.1 query run; a **non-admin, non-jcrc resident** booked a resident-gated room. Their userID: `_______________` (E4)
- [ ] `src/server/auth.ts` uses the shared `canonicalUserID` (so the C2 coverage query and runtime agree on the key — see `02-backend-authz.md` §2.1)

**Preconditions — code**
- [ ] Step 3 deployed: every legacy read in its table removed
- [ ] Step 4 deployed: `legacyMirror` / `PRECEDENCE` deleted; **no** write emits `role` or `requiredRole` in a `$set` **or** a `$setOnInsert` — including `ensureBaseline` (`baseline.ts`) and `loginGrants.ts`, the two session-path writers, whose `roles` `$addToSet` must remain intact
- [ ] `grep -rnE '\brole\s*:|\brequiredRole\b|legacyMirror|PRECEDENCE' src/ scripts/ prisma/schema.prisma` reviewed by hand; only JSX `role=` attributes remain
- [ ] The step-4 deploy is **live on Vercel Production**, not merely merged — a merged-but-unpromoted build is still dual-writing
- [ ] `npx tsc --noEmit` clean after the schema field removal + `prisma generate`

**Preconditions — backup**
- [ ] `node scripts/remediation/backup-role-collections.mjs` run **within the last 2 hours**. Counts recorded: `UserRole ___` / `FacilityAccess ___` / `RoleAuditLog ___` / `PendingRoleGrant ___` / with-legacy-scalar `___` / `___`
- [ ] Atlas snapshot taken **or** the cluster tier is confirmed to offer none and the JSON dump is understood to be the sole backup
- [ ] `restore-legacy-scalars.mjs` **dry-run** and its output inspected — an untested restore is not a restore
- [ ] Rule R2 understood by whoever would execute a revert: never `git checkout` the pre-v2 `schema.prisma`
- [ ] A named person is available for the next 72 hours to act on a failed post-drop check: `_______________`

---

## Done when

- [ ] §5 step 1 sweep run; no `FacilityAccess` row has `requiredRole: "resident"`, and `setFacilityAccess` writes `legacyMirror`, not `roles[0]`
- [ ] `seed-rbac.mjs` deleted with its `Counter` seed and JCRC roster preserved elsewhere
- [ ] `verify-legacy-drop.mjs` exists, exits 0, and wrote a `gate-pass-*.json` marker
- [ ] `backup-role-collections.mjs` wrote a snapshot of all four collections < 2h before the drop
- [ ] Step 3 (reads) and step 4 (writes) both deployed and live on Vercel Production
- [ ] `role` / `requiredRole` removed from `prisma/schema.prisma`; `db push` + `generate` + `tsc --noEmit` clean
- [ ] `drop-legacy-role-fields.mjs` applied; AFTER counts `0` / `0`
- [ ] `db.UserRole.countDocuments({ roles: { $exists: false } })` is `0`
- [ ] Non-admin resident smoke test: login → book a normal room → succeeds
- [ ] Admin smoke test: `/admin` loads; grant + revoke both write `RoleAuditLog` rows
- [ ] `ensureBaseline`'s `$setOnInsert: { role: "" }` removed in the **same commit** as the schema drop; its `$addToSet: { roles: "resident" }` still present and still guarded by the shared eligibility predicate
- [ ] Post-drop counts re-checked at **+24h and +72h**, still `0` / `0` — the window in which a surviving session-path `$setOnInsert` would resurrect the field on a newly-inserted `UserRole` document
- [ ] `restore-legacy-scalars.mjs` exists, asserts rule R2, reconstructs from live `roles[]`, and has been dry-run
- [ ] Doc edits in §8 applied

---

## 8. Edits this document forces on the other plan docs

| File | Line | Change |
|---|---|---|
| `00-overview.md` | 90-97 | Insert **Phase 1b** (resident backfill). Phase 5 "Drop legacy `role`/`requiredRole` (**optional**)" → "(**scheduled**, see `06-legacy-cutover.md`)" |
| `00-overview.md` | 103 | "Decisions D-1 through D-5 answered (D-6 through D-8 may lag)" — stale; all eight are answered |
| `01-data-model.md` | Phase 1 `db push` | **MUST** relax `role String` → `String?` and `requiredRole String` → `String?` in the same push that adds the arrays (§1). Hard precondition for everything here |
| `01-data-model.md` | 154-155 | Delete "The singular `role` is a LEGACY mirror, dual-written for the rollback window only" |
| `01-data-model.md` | 255-277 | **Reverse "Do not delete the file."** `seed-rbac.mjs` is deleted at §5 step 2; provenance moves to `data/jcrc-users.json` + `seed-counters.mjs` |
| `01-data-model.md` | 494-509 | Replace Step 12 wholesale with a pointer to this document |
| `01-data-model.md` | facility seed | Legacy mirror written via `legacyMirror(requiredRoles)`, never `roles[0]` (§0.1) |
| `02-backend-authz.md` | 26-38 | `PRECEDENCE` / `legacyMirror` gain a comment: removed at §5 step 4; `resident` deliberately absent (§0.1) — **and still absent under the revised I-8, where `resident` is stored rather than derived.** Storing it changes the array, never the mirror |
| `02-backend-authz.md` | 588-590 | "Every other `has:` query … until the legacy field is dropped" → cross-reference §5 step 3's finite table |
| `02-backend-authz.md` | 903-904 | `setFacilityAccess` writes `requiredRole: legacyMirror(requiredRoles)`, **not** `roles[0]` (§0.1 — this is a total-lockout bug on revert) |
| `02-backend-authz.md` | `baseline.ts` (Step 2.5), `loginGrants.ts` | Both write the legacy scalar via `$setOnInsert` during the window and are enumerated in §5 step 4's removal table. Neither may write anything else to `UserRole` **beyond its own `$addToSet` of `roles`**. Note the rename `ensureBaselineRole` → `ensureBaseline` and that under the revised I-8 it is a **permanent** hot-path writer, so its `$setOnInsert` must die in the same commit as the schema drop (§5 step 4) |
| `02-backend-authz.md` | `applyRoleChange` (`02:568-575`) | Its `role` mirror is a single `$set: { role: legacyMirror(after) }` and must carry **no** `$setOnInsert` on the same path — MongoDB rejects an update naming `role` in both with `ConflictingUpdateOperators`. §5 step 4 removes the `$set` key |
| `05-verification.md` | 41-42 | Presence check → **containment** check (§4.3) |
| `05-verification.md` | 43-44, 61-62 | Mark as **transitional**; add the post-drop inversions (`role` absent) |
| `05-verification.md` | 195-198 | Rollback row for the `$unset`: replace "run a reverse backfill" with `restore-legacy-scalars.mjs` + rules R1 and R2 + §6.3's residual gap |
| `05-verification.md` | 225 | Delete "Decide D-7" from "out of scope" — it is resolved and gates D-1 (see `02-backend-authz.md` §identity / D-7 sign-in restriction) |

**New files:** `scripts/remediation/verify-legacy-drop.mjs`, `backup-role-collections.mjs`, `drop-legacy-role-fields.mjs`, `restore-legacy-scalars.mjs`, `seed-counters.mjs`, `data/jcrc-users.json`.
**Deleted:** `scripts/remediation/seed-rbac.mjs` (at §5 step 2, early — not at the end).
