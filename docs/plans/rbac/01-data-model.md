**Phase 1 — Data Model, Backfill and Seeding (RBAC v2, revised for D-1…D-8)**

This document replaces v1 `01-data-model.md` wholesale. It owns: the `prisma/schema.prisma` diff, every migration/seed script under `scripts/remediation/`, and the exact command order.

Companion docs — do not duplicate their content here:
- `00-overview.md` — role vocabulary, permission matrix, phase table
- `02-backend-authz.md` — `roles.ts`, `normalizeStoredRoles`, `ensureBaseline` (the creation-time grant and the session-read self-heal), `access.ts`, guards G1–G7, the D-7 `signIn` gate
- `03-admin-dashboard.md` — `/admin`, capability set, bulk UI
- `04-profile-page.md` — profile, `$jsonSchema` dump (D-5)
- `05-verification.md` — test protocol
- `06-legacy-cutover.md` — the one-way drop of `role` / `requiredRole` (D-6). **Nothing in this document drops anything.**
- `07-cca-future.md` — `CcaHead`, `transferCcaHead`, CCA forward-design

---

## 0. What changed from v1, and why

| v1 said | Now | Driver |
|---|---|---|
| No row / empty array = **open to everyone** | No row / empty array = **`["resident"]`**. Every facility gets an explicit row. | D-1 |
| `role` / `requiredRole` are **required** scalars | Both become **optional**, and every new document written by this doc carries `""` | I-2 blocker: the resident backfill and facility seed create documents lacking them, which the *currently deployed* Prisma client throws on |
| Backfill iterates `UserRole` (11 rows) | The resident backfill iterates **`User`** (~515 rows) | Lockout mode 3. Under the STORED baseline this is no longer a visibility bug: a user the backfill misses holds **no** `resident` until their next session read repairs it, so the wrong collection costs booking capability, not just a listing. |
| SCRC resolved **by facility name** | Every facility resolved **by `facilityID`** from a reviewed JSON | Lockout mode 2 — under D-1 a name miss now *locks* a room |
| `CcaHead` "defined now, populated later" | Populated from the **first grant**; still not consulted by the booking path | `07-cca-future.md` |
| Step 12 legacy drop lived here | Moved to `06-legacy-cutover.md` | D-6 needs backup + verification + restore |
| — | New: `PendingRoleGrant`, `BulkRoleImport`, `SystemFlag` | D-8, kill switch |

### 0.1 The load-bearing decision this document encodes

**`resident` is a STORED role in `UserRole.roles`, held by every sign-in-eligible identity including admins, jcrc and cca_head. It is granted at account creation, backfilled AUTHORITATIVELY to the existing population by Step 12, repaired at the session read if it is ever missing, and unstrippable by any role write.**

This supersedes the derived design (I-8 as originally written in `00-overview.md` §2.3, now repealed). `normalizeStoredRoles(storedRoles)` in `src/server/api/services/roles.ts` (owned by `02-backend-authz.md`) **keeps** a stored `"resident"`; it no longer re-derives it. Consequences that this document depends on:

- A user with **no `UserRole` row** is repaired at their next session read by `ensureBaseline()` (I-8b, `02-backend-authz.md`) — but until that read they hold nothing. **Step 12 is therefore authoritative, not advisory**: a partial or failed run is a real booking lockout for the ids it missed, until each of them logs in again. Its VERIFY pass and the `rbac-doctor` line below are the detectors, and re-running the script is the resume.
- `resident` is **not** in `GRANTABLE_ROLES`, so no `set`-shaped payload (dashboard, bulk import, undo) can express it, and the role write path is `$pull(removed)` / `$addToSet(added)` with `removed` grantable-only — so none can strip it either (I-8c). This closes lockout modes 12–16 structurally.
- Storage also gives `/admin` listings, bulk previews and `rbac-doctor` one indexed query instead of a full `User` scan — but that is now a side benefit, not the reason the rows exist.
- **Eligibility is a write guard, never an authorization input.** `isResidentEligible(canonicalUserID(email))` decides who may *receive* the baseline; the stored value alone decides who *has* it. Every writer in this document goes through that predicate (I-8d, I-12), and it is never `E_FORMAT` (L-27, Step 2).

**Consequence to record:** `resident` is never written to the legacy `role` mirror (`PRECEDENCE` stays `["admin","jcrc","cca_head"]`), and never to `FacilityAccess.requiredRole`. See §7.3 and `06-legacy-cutover.md` §0.1.

### 0.2 Ordering invariant, restated for this phase

I-3 is *data → schema → code*, but with one refinement that v1 lacked and that is non-negotiable here:

> **Documents may be CREATED only after the schema push that made the legacy scalars optional (Step 8).** Steps before that may only `$set` array fields onto documents that already exist.

Step 6 (array backfill) obeys this — it never upserts. Steps 11–12 (seed, resident) create documents and run after Step 8.

Independently, **every document this phase creates carries `role: ""` / `requiredRole: ""`** via `$setOnInsert`. An empty string is defined for the still-deployed old Prisma client (which declares the field required and throws on absence *and* on null), and it is falsy — so the live `src/server/api/services/access.ts:36` `if (!required) return true` keeps today's open-by-default behaviour, and `access.ts:19` `row?.role ?? DEFAULT_ROLE` degrades to `""`, which matches no role. **Booking behaviour is unchanged for the whole of Phase 1.**

---

## Step 0 — Protect the backups directory, then back up

`scripts/remediation/backups/` is **not** gitignored today and already contains `merge-backup.json` (63 KB of user records with emails and display names), currently untracked. A `git add -A` would commit PII into history.

1. Append to `.gitignore`:

```gitignore
# migration data dumps — contain user records, never commit
/scripts/remediation/backups/
/scripts/remediation/data/
```

2. Confirm nothing is already in history:

```bash
git log --all --oneline -- scripts/remediation/backups/
```

Empty output required. If not empty, that is a separate PII remediation — raise it before continuing.

3. Back up. Take an Atlas snapshot **if the cluster tier supports it** (M0/M2/M5 do not — check first; if it does not, the JSON dumps written by the scripts below are your only backup and you must say so out loud).

```bash
mongodump --uri "$DATABASE_URL" --collection UserRole      --out scripts/remediation/backups/pre-rbac
mongodump --uri "$DATABASE_URL" --collection FacilityAccess --out scripts/remediation/backups/pre-rbac
mongodump --uri "$DATABASE_URL" --collection UserMatric     --out scripts/remediation/backups/pre-rbac
mongodump --uri "$DATABASE_URL" --collection User           --out scripts/remediation/backups/pre-rbac
```

`mongodump` is likely **not** installed on the Windows dev machine. If it is absent, do not improvise — `backfill-roles-v2.mjs` (Step 6) writes a JSON snapshot of `UserRole` + `FacilityAccess`, and `census-identity.mjs` (Step 3) writes one of `User`. Those two cover everything this phase mutates.

---

## Step 1 — Verify the canonical admin userID (D-4)

D-4 states `E1633673` is the answer. Verify anyway — every grant below is keyed on it.

Create `scripts/remediation/verify-admin-id.mjs`:

```js
/**
 * D-4: confirm the canonical E-format userID for the admin account.
 *   node scripts/remediation/verify-admin-id.mjs your.email@u.nus.edu
 * Read-only.
 */
import { PrismaClient } from "@prisma/client";
import { canonicalUserID } from "./lib/identity.mjs";

const db = new PrismaClient();
const EMAIL = process.argv[2];
if (!EMAIL) throw new Error("usage: node verify-admin-id.mjs <email>");

const canonical = canonicalUserID(EMAIL);
console.log("derived canonical userID:", JSON.stringify(canonical));

const user = await db.user.findFirst({
  where: { email: { equals: EMAIL, mode: "insensitive" } },
  select: { id: true, email: true, userID: true },   // never select passwordHash — see Step 3
});
console.log("User row:", user ?? "NOT FOUND");
console.log("User.userID (LEGACY, not the role key):", user?.userID ?? null);

const matric = await db.userMatric.findUnique({ where: { userID: canonical } });
console.log("UserMatric row for canonical id:", matric ?? "none");
await db.$disconnect();
```

```bash
node scripts/remediation/verify-admin-id.mjs your.email@u.nus.edu
```

**Stop if the derived value is not `E1633673`** — use the printed value in `ADMIN_USER_ID` everywhere below. **Stop if it is `""`** — that means the address is not `@u.nus.edu`, which under D-7 (`02-backend-authz.md`) means the account cannot sign in at all. Resolve that first.

Note `User.userID` is printed for information only. It holds an A-format matric on ~515 rows and **is never the role key** (I-1).

---

## Step 2 — The identity module and its script mirror

Every key derivation in this phase must be byte-identical to the runtime one, or grants land under keys no session matches (lockout modes 5, 7, 18). **Under the stored baseline this is more critical than it was under derivation, not less:** a mis-keyed `resident` row is not merely an invisible user, it is a user who holds no baseline at all until the session-read repair writes one under the correct key.

`src/lib/identity.ts` is the source of truth and is owned by `02-backend-authz.md`. It exports the **anchored** `canonicalUserID`, which returns `""` for anything that is not an exact `@u.nus.edu` address. Scripts cannot import TypeScript, so create a literal mirror:

`scripts/remediation/lib/identity.mjs`:

```js
/**
 * MIRROR of src/lib/identity.ts. Source of truth is that file.
 * Any edit here MUST be made there and vice versa; scripts/remediation/lib/
 * identity.parity.test.mjs asserts they agree over a fixture list.
 *
 * Anchored, ASCII-only, and `+` is DELIBERATELY excluded from the localpart —
 * e1234567+x@u.nus.edu would otherwise canonicalise to a DIFFERENT role key for
 * the same human. See 02-backend-authz.md for the rationale and Step 3 for the
 * census that must show zero existing plus-addressed accounts.
 */
const NUS_STUDENT_EMAIL = /^([A-Z0-9._%-]+)@U\.NUS\.EDU$/;

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function isNusStudentEmail(email) {
  return NUS_STUDENT_EMAIL.test(normalizeEmail(email).toUpperCase());
}

/** Returns "" for anything that is not a valid @u.nus.edu address. */
export function canonicalUserID(email) {
  const m = NUS_STUDENT_EMAIL.exec(normalizeEmail(email).toUpperCase());
  return m ? m[1] : "";
}

/** Resident eligibility. NOT E_FORMAT — g.s_samuel@u.nus.edu is a real account. */
export function isResidentEligible(userID) {
  return typeof userID === "string" && userID.length > 0 && !userID.includes("@");
}

/** Validation of GRANT TARGETS only. Never an eligibility test. */
export const E_FORMAT = /^E\d{7}$/;
```

**`isResidentEligible` must never be `E_FORMAT.test(id)`.** Non-E-format `@u.nus.edu` localparts exist in this database — `g.s_samuel@u.nus.edu` is present in `scripts/remediation/backups/merge-backup.json`. Gating eligibility on `E_FORMAT` would silently lock those accounts out of all booking.

Parity test, `scripts/remediation/lib/identity.parity.test.mjs` — run it in CI and before Step 6:

```js
const FIXTURES = [
  "e1234567@u.nus.edu", "E1234567@U.NUS.EDU", "  e1234567@u.nus.edu  ",
  "g.s_samuel@u.nus.edu", "test@u.nus.edu", "bob@u.nus.edu.evil.com",
  "bob@evil.com@u.nus.edu", "bob@sub.u.nus.edu", "bob@nus.edu.sg",
  "e1234567+x@u.nus.edu", "", null,
];
// assert canonicalUserID(f) identical between src/lib/identity.ts and this mirror
// for every f, and that canonicalUserID(f) !== "" <=> isNusStudentEmail(f).
```

---

## Step 3 — Census: know the population before touching it

`scripts/remediation/census-identity.mjs`. Read-only. Writes `backups/identity-census-<ISO>.json`.

It uses `$runCommandRaw` with an explicit projection throughout. **Never `db.user.findMany()` without a `select`** — `User.passwordHash` is a required non-nullable scalar (`prisma/schema.prisma:353`) while `PrismaAdapter` creates Google rows without it, so an unprojected read throws for the whole collection (I-2, lockout mode 21).

```js
import { PrismaClient } from "@prisma/client";
import { canonicalUserID, isNusStudentEmail, E_FORMAT } from "./lib/identity.mjs";
const db = new PrismaClient();
const raw = (c) => db.$runCommandRaw(c);

async function findAll(collection, projection) {
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

const users = await findAll("User", { _id: 1, email: 1, userID: 1, displayName: 1, block: 1 });

const nonNus = [], empty = [], plusAddr = [], whitespace = [], nonE = [];
const byCanonical = new Map(), collisions = [];
for (const u of users) {
  const e = String(u.email ?? "");
  if (e !== e.trim()) whitespace.push(u._id);
  if (/\+/.test(e)) plusAddr.push(e);
  const id = canonicalUserID(e);
  if (!id) { (e.trim() ? nonNus : empty).push({ _id: u._id, email: e, name: u.displayName }); continue; }
  if (!E_FORMAT.test(id)) nonE.push(id);              // informational, NOT a problem
  if (byCanonical.has(id)) collisions.push({ id, emails: [byCanonical.get(id), e] });
  else byCanonical.set(id, e);
}

console.log({
  totalUsers: users.length,
  eligible: byCanonical.size,
  nonNus: nonNus.length,           // D-7 migration list — hand-review with the user
  blankEmail: empty.length,
  canonicalCollisions: collisions.length,   // merged/deduped accounts
  nonEFormatCanonical: nonE.length,         // legitimate; must NOT be excluded
  plusAddressed: plusAddr.length,
  whitespaceEmails: whitespace.length,
  missingPasswordHash: (await raw({ count: "User", query: { passwordHash: { $exists: false } } })).n,
  oauthProviders: (await raw({ distinct: "Account", key: "provider" })).values,
});
console.log("NON-NUS ROWS:", JSON.stringify(nonNus, null, 2));
console.log("COLLISIONS:",   JSON.stringify(collisions, null, 2));

// UserCCA key-format probe — blocking input for 07-cca-future.md.
const cca = await findAll("UserCCA", { ccaID: 1, userID: 1 });
console.log("UserCCA total:", cca.length,
  "E-format:", cca.filter((r) => E_FORMAT.test(r.userID)).length,
  "A-format:", cca.filter((r) => /^A\d{7}[A-Z]$/i.test(r.userID)).length);
const seen = new Set(), dup = [];
for (const r of cca) { const k = `${r.ccaID}|${r.userID}`; if (seen.has(k)) dup.push(k); seen.add(k); }
console.log("UserCCA duplicate (ccaID,userID) pairs:", dup.length);
```

Act on each result **before** Step 6:

| Result | Action |
|---|---|
| `nonNus > 0` | Hand-review with the user. Under D-7 these accounts cannot sign in. `AuthAllowlist` (owned by `02-backend-authz.md`) is the escape hatch; note it restores **sign-in only** — an allowlisted non-NUS account canonicalises to `""`, is never written a stored `resident` by any path in this document (I-8d), and therefore still cannot book. The outcome is identical to the derived design; it is now a stored fact rather than a derived one. Correct the address, merge, or accept the block. **If your own admin account is in this list, stop.** |
| `blankEmail > 0` | These accounts are already broken (`user.ts:87-90` throws for them). Repair or delete; do not backfill them. |
| `canonicalCollisions > 0` | Two `User` rows collapse to one role key — merged-account residue (`merge-accounts.mjs`, commits `568c51c`/`fe9afe8`). Resolve before Step 12: the backfill dedupes and exits 1 rather than guessing, so an unresolved collision means one of two merged humans gets no baseline at all. |
| `missingPasswordHash > 0` | Change `prisma/schema.prisma:353` to `passwordHash String?` **in the Step 7 diff**. Read-side only; writes nothing; touches no validator. Without it, doc 02's added session-callback `db.user.findUnique` throws and logs those users out. |
| `plusAddressed > 0` | Decide explicitly: relax the regex, or allowlist and re-key. Do not discover this in production. |
| `whitespaceEmails > 0` | The new `.trim()` re-keys these users. Their existing `UserMatric` / `Bookings` / `UserCCA` rows are orphaned — Step 4 enumerates them and Step 4's remediation must run. |
| `nonEFormatCanonical > 0` | **Informational only.** Never exclude these from the resident backfill — excluding them now withholds the stored baseline permanently rather than mis-deriving it once (L-27). |
| `UserCCA` A-format or duplicates | Record in `07-cca-future.md`. Does not block this phase. |

---

## Step 4 — `verify-canonical-rekey.mjs` — BLOCKING

Adopting the anchored `canonicalUserID` changes the derived key for any email that is not exactly `X@u.nus.edu`. The old derivation was `email.toUpperCase().replace("@U.NUS.EDU","")` — unanchored, no `.trim()`. `foo@u.nus.edu.sg` went from `FOO.SG` to `""`; ` e1234567@u.nus.edu` went from `E1234567 ` (trailing space) to `E1234567`.

The canonical userID is the ownership key on **four** collections, not one:

| Collection | Field | Loss if orphaned |
|---|---|---|
| `UserMatric` | `userID` (`schema.prisma:266-271`) | Thrown back into the matric gate |
| `UserRole` | `userID` (`:246`) | Loses granted roles |
| `Bookings` | `userID` (`:113`, indexed `:116-117`) | **Every existing booking vanishes; `deleteBooking`'s ownership check at `facilitiesBooking.ts:384` fails, so they cannot cancel their own bookings** |
| `UserCCA` | `userID` (`:368`) | Loses CCA membership |

`scripts/remediation/verify-canonical-rekey.mjs`:

```js
// For every User: oldKey = String(email??"").toUpperCase().replace("@U.NUS.EDU","")
//                 newKey = canonicalUserID(email)
// If oldKey !== newKey, count documents keyed on oldKey in ALL FOUR collections.
// Print the affected bookingIDs, not just a count.
// Exit 1 if any orphan exists.
```

```bash
node scripts/remediation/verify-canonical-rekey.mjs
```

**Deploy of Phase 2 is blocked on this printing zero orphans.** If orphans exist, write `scripts/remediation/rekey-canonical.mjs` to rewrite `Bookings.userID`, `UserCCA.userID`, `UserMatric.userID` and `UserRole.userID` from the old key to the new one — in one Phase-1 step, with a dry run and a JSON backup — and re-run this verifier until it is clean.

---

## Step 5 — Enumerate facilities and hand-write the gating map

Under D-1 the gating class **cannot be derived**: `Facilities` has only `facilityID`, `facilityLocation`, `facilityName` (`prisma/schema.prisma:136-142`).

```bash
node -e "import('@prisma/client').then(async({PrismaClient})=>{const d=new PrismaClient();
console.log('facilities:', await d.facilities.count(), 'access rows:', await d.facilityAccess.count());
console.log(JSON.stringify(await d.facilities.findMany({select:{facilityID:true,facilityName:true,facilityLocation:true},orderBy:{facilityID:'asc'}}),null,2));
console.log('ccaID 0 exists (see 07):', await d.cCA.count({where:{ccaID:0}}));
await d.\$disconnect();})"
```

Create `scripts/remediation/data/facility-roles.json` **keyed on `facilityID`, never on `facilityName`**:

```json
{
  "_comment": "facilityID -> requiredRoles. Facilities NOT listed here get [\"resident\"]. facilityID -1 is the sentinel filtered by Calender_v2.tsx:306 and is excluded entirely. Allowed values: resident | jcrc | cca_head. NEVER 'admin' — admin is an implicit bypass and is never stored.",
  "byFacilityID": {
    "3": ["jcrc"],
    "7": ["cca_head"],
    "8": ["cca_head"]
  }
}
```

Replace the example ids with the real ones from the enumeration and **have a second person review the mapping** before Step 11. The vocabulary here is `FACILITY_ROLES = ["resident","jcrc","cca_head"]` — a different enum from `GRANTABLE_ROLES`, defined in `02-backend-authz.md`. `admin` is invalid in this file and the seed rejects it.

---

## Step 6 — Backfill array fields onto EXISTING documents (before schema push)

`scripts/remediation/backfill-roles-v2.mjs`. Unchanged from v1 in substance — it is still correct — with one clarification made explicit.

```js
/**
 * RBAC v2 step 1: backfill array-shaped role fields onto EXISTING documents.
 * MUST run BEFORE `prisma db push` and BEFORE any code deploy (invariant I-3).
 *
 *   node scripts/remediation/backfill-roles-v2.mjs              # dry run
 *   APPLY=yes node scripts/remediation/backfill-roles-v2.mjs    # apply
 *
 * Idempotent. Uses $runCommandRaw only, so it works before `prisma generate`
 * knows about the new fields and never issues a typed read that could throw on
 * a document of the old shape.
 *
 * CREATES NO DOCUMENTS. Every update is a $set on a document matched by its
 * existing key, with NO upsert. Document creation is not permitted until after
 * Step 8 has made the legacy scalars optional (doc 01 section 0.2).
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const db = new PrismaClient();
const APPLY = process.env.APPLY === "yes";
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

/** Drain a raw cursor fully. `batchSize` is a request, not a guarantee. */
async function findAll(collection) {
  const out = [];
  let res = await raw({ find: collection, filter: {}, batchSize: 1000 });
  out.push(...(res?.cursor?.firstBatch ?? []));
  let id = res?.cursor?.id;
  while (id && String(id) !== "0") {
    res = await raw({ getMore: id, collection, batchSize: 1000 });
    out.push(...(res?.cursor?.nextBatch ?? []));
    id = res?.cursor?.id;
  }
  return out;
}

async function main() {
  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN ===");

  const userRole = await findAll("UserRole");
  const facilityAccess = await findAll("FacilityAccess");
  mkdirSync(join(HERE, "backups"), { recursive: true });
  writeFileSync(
    join(HERE, "backups", "roles-v2-pre-backfill.json"),
    JSON.stringify({ at: new Date().toISOString(), userRole, facilityAccess }, null, 2),
  );
  console.log(`Backup: ${userRole.length} UserRole + ${facilityAccess.length} FacilityAccess rows`);

  // 1. Filter on the ABSENCE of `roles`, not the presence of `role`, so a
  //    document with neither field is repaired rather than skipped.
  const needRoles = userRole.filter((d) => !Array.isArray(d.roles));
  console.log(`[1] UserRole.roles backfill: ${needRoles.length} row(s)`);
  for (const d of needRoles) {
    const roles = d.role ? [d.role] : [];
    console.log(`  ${APPLY ? "+" : "~"} ${d.userID}: roles -> ${JSON.stringify(roles)}`);
    if (APPLY) await raw({ update: "UserRole", updates: [{ q: { userID: d.userID }, u: { $set: { roles } } }] });
  }

  // 2. Same for FacilityAccess.requiredRoles.
  //    NOTE: the legacy `requiredRole` on existing rows is left EXACTLY as-is.
  //    The one existing row is SCRC with requiredRole:"jcrc"; preserving it is
  //    what keeps the still-deployed access.ts:36-39 enforcing today's gate.
  const needReq = facilityAccess.filter((d) => !Array.isArray(d.requiredRoles));
  console.log(`[2] FacilityAccess.requiredRoles backfill: ${needReq.length} row(s)`);
  for (const d of needReq) {
    const requiredRoles = d.requiredRole ? [d.requiredRole] : [];
    console.log(`  ${APPLY ? "+" : "~"} facility ${d.facilityID}: -> ${JSON.stringify(requiredRoles)}`);
    if (APPLY) await raw({ update: "FacilityAccess", updates: [{ q: { facilityID: d.facilityID }, u: { $set: { requiredRoles } } }] });
  }

  // 3. Verify.
  const badUR = (await findAll("UserRole")).filter((d) => !Array.isArray(d.roles));
  const badFA = (await findAll("FacilityAccess")).filter((d) => !Array.isArray(d.requiredRoles));
  console.log(`\n=== VERIFY ===`);
  console.log(`UserRole missing roles[]:               ${badUR.length}`);
  console.log(`FacilityAccess missing requiredRoles[]: ${badFA.length}`);
  if (APPLY && (badUR.length || badFA.length)) {
    console.error("*** BACKFILL INCOMPLETE — do not proceed to db push ***");
    process.exitCode = 1;
  }
}

main().then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
```

```bash
node scripts/remediation/backfill-roles-v2.mjs
APPLY=yes node scripts/remediation/backfill-roles-v2.mjs
```

Expect 11 `UserRole` rows and 1 `FacilityAccess` row backfilled. **Both VERIFY counts must be 0 before Step 7.**

---

## Step 7 — Schema changes

Edit `prisma/schema.prisma`. Replace `UserRole` (currently `:243-249`) and `FacilityAccess` (`:251-256`), append five new models, and add one index to `UserMatric`.

```prisma
/// Role assignments kept out of the validator-guarded User collection (#23).
/// MULTI-ROLE (RBAC v2): `roles` is the source of truth.
///
/// `resident` IS stored here and IS authoritative. Every eligible identity
/// holds it, admins included. normalizeStoredRoles()
/// (src/server/api/services/roles.ts) keeps it verbatim. A row that lacks it is
/// repaired by ensureBaseline() at the next session read (I-8b); no set-payload
/// can revoke it because role writes are $pull/$addToSet over GRANTABLE_ROLES,
/// which excludes it (I-8c).
///
/// Keyed on the canonical userID = canonicalUserID(email), the same key
/// UserMatric, Bookings, UserCCA and session.user.userID use. NEVER key on
/// User.userID: ~515 users have an A-format matric there (invariant I-1).
///
/// INVARIANT I-2: no required non-list scalar may be added to this model. It is
/// already populated and is read inside the session callback; Prisma throws on
/// a document missing a required scalar, which would break login for everyone.
/// This is why `role` below is OPTIONAL — the resident backfill AND the
/// runtime ensureBaseline() both create documents that do not naturally carry
/// it. Every such write must $setOnInsert `role: ""` (I-9): empty string, never
/// null, never "user".
model UserRole {
  id               String    @id @default(auto()) @map("_id") @db.ObjectId
  userID           String    @unique
  roles            String[]  @default([])
  /// LEGACY mirror, dual-written for the rollback window only. Dropped in
  /// 06-legacy-cutover.md. NEVER holds "resident" (see doc 06 section 0.1).
  role             String?
  /// Set once PendingRoleGrant has been consulted for this user. Its purpose is
  /// to make the steady-state cost of the pending-grant check exactly ZERO
  /// extra queries. Nullable — I-2.
  pendingCheckedAt DateTime?
  updatedAt        DateTime?
  updatedBy        String?

  @@index([roles], map: "roles_multikey")
}

/// Per-facility access requirement kept out of the validator-guarded
/// Facilities collection (#23).
///
/// requiredRoles is an OR-set: a user may book if they hold ANY listed role.
/// `admin` always passes and is NEVER stored here.
///
/// SEMANTICS CHANGED BY D-1. No row for a facilityID, OR an empty
/// requiredRoles array, both mean ["resident"] — the DEFAULT, not open-to-all.
/// There is no "open to everyone" state any more. Every facility is given an
/// explicit row by seed-roles-v2.mjs so that "configured as a normal room" is
/// distinguishable from "never configured" (see rbac-doctor's UNCONFIGURED
/// line). Allowed values: resident | jcrc | cca_head.
///
/// Same I-2 no-required-scalar invariant as UserRole.
model FacilityAccess {
  id            String    @id @default(auto()) @map("_id") @db.ObjectId
  facilityID    Int       @unique
  requiredRoles String[]  @default([])
  /// LEGACY mirror. Frozen: existing values are preserved untouched, new rows
  /// get "". Nothing after this phase ever writes it. Dropped in doc 06.
  requiredRole  String?
  updatedAt     DateTime?
  updatedBy     String?
}

/// Append-only audit trail for every role and facility-access mutation, and for
/// every DENIED attempt. Brand-new collection, no $jsonSchema validator.
/// Append-only is a code contract — Mongo cannot enforce it. There is no update
/// or delete path in any router, and none may be added.
model RoleAuditLog {
  id               String   @id @default(auto()) @map("_id") @db.ObjectId
  at               DateTime @default(now())
  actorUserID      String
  /// Actor's roles AT THE TIME. Denormalized on purpose: a join back to
  /// UserRole answers "are they authorized now", not "were they authorized then".
  actorRoles       String[] @default([])
  targetUserID     String?
  targetFacilityID Int?
  /// Reserved now so the future CCA system's history is queryable alongside
  /// role history with no backfill. See 07-cca-future.md.
  targetCcaID      Int?
  /// One of AUDIT_ACTIONS in src/server/api/services/roles.ts:
  /// grant | revoke | set | facilityAccess.set | denied | pending.create |
  /// pending.claim | pending.revoke | booking.denied.shadow |
  /// ccaHead.grant | ccaHead.revoke | ccaHead.transfer
  action           String
  rolesBefore      String[] @default([])
  rolesAfter       String[] @default([])
  reason           String?
  ok               Boolean  @default(true)
  denyReason       String?
  batchId          String?  // groups one bulk import, or the two halves of a handover

  @@index([at(sort: Desc)],               map: "at_desc")
  @@index([targetUserID, at(sort: Desc)], map: "target_at")
  @@index([actorUserID,  at(sort: Desc)], map: "actor_at")
  @@index([batchId],                      map: "batch")
  @@index([targetCcaID,  at(sort: Desc)], map: "cca_at")
}

/// A role grant for someone who has NOT signed up yet (D-8). Applied at their
/// first login, re-authorized against the granter's CURRENT roles at that time.
///
/// SECURITY: `userID` is ALWAYS a canonical E-format id, derived from an
/// explicit E-id or from an @u.nus.edu email. NEVER from a matric number
/// (UserMatric.matric is self-asserted — src/server/api/routers/user.ts:85-99)
/// and NEVER from a display name. Whoever first controls that NUS address gets
/// this grant, so the trust boundary is exactly NUS account issuance — the same
/// boundary D-7 relies on. `resident` may never be deferred.
model PendingRoleGrant {
  id             String   @id @default(auto()) @map("_id") @db.ObjectId
  userID         String   @unique
  roles          String[] @default([])
  createdAt      DateTime @default(now())
  createdBy      String
  createdByRoles String[] @default([])
  expiresAt      DateTime
  batchId        String?
  reason         String?

  @@index([expiresAt], map: "expires")
  @@index([batchId],   map: "batch")
}

/// Header row for one bulk role import (D-8), so a large import is one
/// reviewable and undoable object rather than N loose audit rows.
model BulkRoleImport {
  id          String    @id @default(auto()) @map("_id") @db.ObjectId
  batchId     String    @unique
  actorUserID String
  actorRoles  String[]  @default([])
  mode        String    // "add" | "set"
  startedAt   DateTime  @default(now())
  finishedAt  DateTime?
  note        String?
  /// batchId of the import this one undoes / the undo that reversed this one.
  undoOf      String?
  undoneBy    String?

  @@index([startedAt(sort: Desc)],              map: "started_desc")
  @@index([actorUserID, startedAt(sort: Desc)], map: "actor_started")
}

/// Live operational flags. New collection, no validator. Read on the booking
/// path behind a short in-process cache. Exists because Vercel snapshots env
/// vars per deployment — an env var alone cannot be a no-redeploy kill switch.
/// Key in use: "rbac.booking.enforcement" -> "off" | "permissive" | "enforce".
model SystemFlag {
  id        String    @id @default(auto()) @map("_id") @db.ObjectId
  key       String    @unique
  value     String
  updatedAt DateTime?
  updatedBy String?
}

/// Which CCA(s) a user heads. `cca_head` CANNOT be derived from existing data:
/// CCA and UserCCA are BOTH validator-guarded and neither has a head/position
/// column, so an `isHead` field is impossible.
///
/// POPULATED FROM THE FIRST GRANT, not "later": every cca_head grant writes a
/// row here in the same transaction. This collection is DELIBERATELY NOT
/// consulted by the booking path in this phase — per D-1 any cca_head may book
/// any CCA-gated room. The single function that will start consulting it is
/// `canBookWithRoles` in src/server/api/services/access.ts; adding an optional
/// `ccaID` parameter there is the only edit needed to make cca_head scoped.
/// See 07-cca-future.md.
model CcaHead {
  id        String   @id @default(auto()) @map("_id") @db.ObjectId
  userID    String
  ccaID     Int
  grantedAt DateTime @default(now())
  grantedBy String?

  @@unique([userID, ccaID], map: "user_cca_head")
  @@index([ccaID],          map: "ccaID")
}
```

Add to the existing `UserMatric` model (`:266-271`) — no new field, index only:

```diff
 model UserMatric {
   id     String @id @default(auto()) @map("_id") @db.ObjectId
   userID String @unique
   matric String
+
+  /// Added for bulk matric -> userID resolution (D-8). Deliberately NOT
+  /// @unique: duplicate matrics are possible and must surface as AMBIGUOUS in
+  /// the bulk preview, not as a write failure.
+  @@index([matric], map: "matric")
 }
```

**If Step 3 reported `missingPasswordHash > 0`**, also apply:

```diff
 model User {
-  passwordHash   String
+  passwordHash   String?
```

Read-side only. It writes nothing and the `User` `$jsonSchema` validator is untouched (making a Prisma field optional does not alter stored documents). Without it, doc 02's added session-callback `db.user.findUnique` throws on Google-adapter rows and logs those users out.

Deliberately absent:

- **No `updatedAt DateTime @updatedAt`** (non-nullable) anywhere. I-2. This is the single most dangerous thing in the original designs.
- **No new fields on `User`, `Facilities`, `CCA`, `UserCCA`, `Posts`.** All are `$jsonSchema`-guarded.
- **No `@@unique([ccaID, userID])` on `UserCCA` in this phase.** An index adds no field so it does not violate the validator invariant, but the Step 3 census may show duplicates and the `UserCCA.userID` key format is unresolved. `07-cca-future.md` owns it; if it lands, it lands in the **same single `db push`** as everything else, after all backfills.

Note `@@index([roles])` becomes a Mongo multikey index. It turns "list every user with role X" from a collection scan into an index scan with fetch — a large win, but **not** a covering index; multikey indexes never cover.

---

## Step 8 — Push and generate

```bash
npx prisma db push
npx prisma generate
npx tsc --noEmit
```

**If `db push` prompts for `--accept-data-loss`, stop.** Nothing here should cause it. A prompt means a field was mistyped as required, or you have accidentally staged the doc-06 legacy drop.

Verify in Atlas:
- `UserRole` has `roles_multikey`
- `RoleAuditLog` exists with five indexes
- `PendingRoleGrant`, `BulkRoleImport`, `SystemFlag`, `CcaHead` exist
- `UserMatric` has a `matric` index

Then assert the deployed client still reads cleanly — this is the guard for the I-2 blocker:

```bash
node -e "import('@prisma/client').then(async({PrismaClient})=>{const d=new PrismaClient();
console.log('UserRole rows readable:',      (await d.userRole.findMany()).length);
console.log('FacilityAccess rows readable:',(await d.facilityAccess.findMany()).length);
await d.\$disconnect();})"
```

> Prisma 6.10 supports `@@index` on scalar lists for MongoDB and `roles: { has: X }` filters. Confirm both with the Step 15 smoke query before relying on them; the fallback is to fetch the (tiny) `UserRole` collection and filter in memory. `02-backend-authz.md`'s last-admin guard and `03-admin-dashboard.md`'s role filter both depend on `has`.

---

## Step 9 — Retire `seed-rbac.mjs`, preserving its non-role logic

`scripts/remediation/seed-rbac.mjs` writes the legacy singular shape (`:28-33`, `:46-50`) and hardcodes an 11-id jcrc grant list. Running it after Step 6 desynchronises `role` and `roles`. It must be neutralised **now**, at Step 9 — not deferred to doc 06 — because a single run during the multi-week window silently re-creates the legacy field and grants jcrc to eleven hardcoded ids.

It also seeds the `bookingID` counter (`:55-66`), which **nothing else does**. That logic must survive.

1. Move the counter seed into a new `scripts/remediation/seed-counters.mjs`, verbatim:

```js
const last = await db.bookings.findFirst({ orderBy: { bookingID: "desc" }, select: { bookingID: true } });
await db.counter.upsert({
  where: { key: "bookingID" },
  create: { key: "bookingID", seq: last?.bookingID ?? 0 },
  update: {},
});
```

2. Move the 11 ids into `scripts/remediation/data/jcrc-users.json` (Step 10) — that file becomes their only home.
3. **Delete `scripts/remediation/seed-rbac.mjs`.** v1 said "do not delete the file, it is the provenance record"; that reason is discharged once the ids are in the JSON and the counter logic is in `seed-counters.mjs`.
4. Update `scripts/remediation/README.md`: replace the "Step 1 — Seed RBAC" section with a pointer to `seed-roles-v2.mjs` + `seed-counters.mjs` and a link to this document.

---

## Step 10 — Create the roster data file

`scripts/remediation/data/jcrc-users.json` (the directory is gitignored per Step 0):

```json
{
  "_comment": "Canonical userIDs = canonicalUserID(email). NOT A-format matric numbers. These 11 were hardcoded in the now-deleted seed-rbac.mjs; replace with the real roster.",
  "jcrc": [
    "E1293802", "E1454218", "E1337187", "E1122423", "E1121407", "E1186145",
    "E1249457", "E1397941", "E1121047", "E1156691", "E1375422"
  ]
}
```

Per D-8 this file is a bootstrap only. Ongoing JCRC onboarding is the in-app bulk import (`03-admin-dashboard.md`), which resolves matric/name/NUSNET, previews, and creates `PendingRoleGrant` rows for people who have not signed up. Do not extend this JSON as the long-term roster.

---

## Step 11 — Seed script

`scripts/remediation/seed-roles-v2.mjs`.

```js
/**
 * RBAC v2 step 2: grant roles and configure facility access for EVERY facility.
 *
 *   node scripts/remediation/seed-roles-v2.mjs              # dry run
 *   APPLY=yes node scripts/remediation/seed-roles-v2.mjs    # apply
 *
 * PROPERTIES THAT ARE LOAD-BEARING — do not "simplify" these away:
 *  - Grants use $addToSet. A re-run must NEVER revoke a role a human granted
 *    through /admin in between runs.
 *  - Facilities are resolved BY facilityID from data/facility-roles.json, never
 *    by facilityName. A rename must be inert; under D-1 a name miss would LOCK
 *    a room rather than open it (lockout mode 2).
 *  - Every facility gets a row, including plain ["resident"] ones, so
 *    rbac-doctor can distinguish "configured normal" from "never configured".
 *  - New rows get $setOnInsert legacy scalars of "" so the STILL-DEPLOYED old
 *    Prisma client can read them (I-2) and so old access.ts keeps today's
 *    behaviour. Existing rows' legacy scalars are NEVER touched — that is what
 *    keeps SCRC gated exactly as it is today throughout Phase 1.
 *  - The UserRole legacy mirror is the HIGHEST-PRIVILEGE role, not roles[0].
 *    roles[0] would mirror an admin+jcrc user as "jcrc", so a rollback would
 *    silently demote them. "resident" is NEVER mirrored (doc 06 section 0.1).
 *  - E-format validation THROWS before any write. A mis-keyed grant creates a
 *    row no session will ever match: it looks like success and does nothing.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { E_FORMAT } from "./lib/identity.mjs";

const db = new PrismaClient();
const APPLY = process.env.APPLY === "yes";
const FORCE_FACILITY = process.env.FORCE_FACILITY === "yes";
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);
const now = () => ({ $date: new Date().toISOString() });

const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? "E1633673";
const ACTOR = "system:seed-roles-v2";
const SENTINEL_FACILITY_ID = -1;                  // filtered by Calender_v2.tsx:306
const DEFAULT_REQUIRED_ROLES = ["resident"];
const FACILITY_ROLES = ["resident", "jcrc", "cca_head"];   // NEVER "admin"

/** Highest privilege first. Single source of truth for the legacy mirror.
 *  "resident" is deliberately ABSENT — the only consumer of the mirror is the
 *  pre-v2 access.ts, which is default-OPEN and cannot interpret it. */
const PRECEDENCE = ["admin", "jcrc", "cca_head"];
const legacyMirror = (roles) => PRECEDENCE.find((r) => roles.includes(r)) ?? "";

function loadJson(name, key) {
  const p = join(HERE, "data", name);
  if (!existsSync(p)) throw new Error(`Missing ${p} — create it (doc 01 steps 5/10).`);
  return JSON.parse(readFileSync(p, "utf8"))[key] ?? (key === "byFacilityID" ? {} : []);
}

/** Hard gate. Throws before the first write — validation is cheap. */
function validateIds(ids, label) {
  const bad = ids.filter((id) => !E_FORMAT.test(id));
  if (bad.length) throw new Error(
    `${label}: ${bad.length} non-E-format userID(s): ${bad.join(", ")}. ` +
    `Grant targets MUST be canonical E-format, not A-format matrics (I-1).`);
  return ids;
}

async function readRoles(userID) {
  const r = await raw({ find: "UserRole", filter: { userID }, limit: 1 });
  const doc = r?.cursor?.firstBatch?.[0];
  return Array.isArray(doc?.roles) ? doc.roles : doc?.role ? [doc.role] : [];
}

async function audit(entry) {
  try {
    await raw({ insert: "RoleAuditLog", documents: [{
      at: now(), actorUserID: ACTOR, actorRoles: ["admin"], ok: true,
      rolesBefore: [], rolesAfter: [], ...entry,
    }]});
  } catch (e) {
    console.error("! AUDIT WRITE FAILED (privilege change still applied):", e.message);
    process.exitCode = 1;
  }
}

async function grant(userID, role) {
  const rolesBefore = await readRoles(userID);
  if (rolesBefore.includes(role)) { console.log(`  = ${userID} already has "${role}"`); return; }
  const rolesAfter = [...rolesBefore, role];
  console.log(`  ${APPLY ? "+" : "~"} ${userID}: ${JSON.stringify(rolesBefore)} -> ${JSON.stringify(rolesAfter)}`);
  if (!APPLY) return;
  await raw({ update: "UserRole", updates: [{
    q: { userID },
    u: {
      $addToSet: { roles: role },
      $set:      { role: legacyMirror(rolesAfter), updatedAt: now(), updatedBy: ACTOR },
    },
    upsert: true,
  }]});
  await audit({ targetUserID: userID, action: "grant", rolesBefore, rolesAfter, reason: "RBAC v2 seed" });
}

async function main() {
  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN ===");

  // [1] admin
  console.log(`\n[1] grant admin to ${ADMIN_USER_ID}`);
  validateIds([ADMIN_USER_ID], "ADMIN_USER_ID");
  await grant(ADMIN_USER_ID, "admin");

  // [2] jcrc roster
  const jcrc = validateIds(loadJson("jcrc-users.json", "jcrc"), "jcrc-users.json");
  console.log(`\n[2] grant jcrc to ${jcrc.length} user(s)`);
  for (const id of jcrc) await grant(id, "jcrc");

  // [3] FacilityAccess for EVERY facility, keyed on facilityID.
  const map = loadJson("facility-roles.json", "byFacilityID");
  for (const [k, v] of Object.entries(map)) {
    if (!Array.isArray(v) || v.length === 0)
      throw new Error(`facility-roles.json: facilityID ${k} must be a non-empty array`);
    const bad = v.filter((r) => !FACILITY_ROLES.includes(r));
    if (bad.length) throw new Error(
      `facility-roles.json: facilityID ${k} has invalid role(s) ${bad.join(", ")}. ` +
      `Allowed: ${FACILITY_ROLES.join(" | ")}. "admin" is an implicit bypass and is never stored.`);
  }

  const facilities = (await db.facilities.findMany({
    select: { facilityID: true, facilityName: true }, orderBy: { facilityID: "asc" },
  })).filter((f) => f.facilityID !== SENTINEL_FACILITY_ID);

  const unmapped = Object.keys(map).filter((k) => !facilities.some((f) => f.facilityID === Number(k)));
  if (unmapped.length) throw new Error(
    `facility-roles.json references facilityID(s) that do not exist: ${unmapped.join(", ")}`);

  console.log(`\n[3] FacilityAccess for ${facilities.length} facility/facilities`);
  for (const f of facilities) {
    const desired  = map[String(f.facilityID)] ?? DEFAULT_REQUIRED_ROLES;
    const existing = (await raw({ find: "FacilityAccess", filter: { facilityID: f.facilityID }, limit: 1 }))
      ?.cursor?.firstBatch?.[0];
    const cur   = existing?.requiredRoles ?? [];
    const after = FORCE_FACILITY || !existing ? desired : [...new Set([...cur, ...desired])];

    if (existing && !FORCE_FACILITY && JSON.stringify([...cur].sort()) !== JSON.stringify([...after].sort()))
      console.warn(`  ! facilityID ${f.facilityID} already has ${JSON.stringify(cur)}; ` +
                   `unioning to ${JSON.stringify(after)}. FORCE_FACILITY=yes to replace.`);

    console.log(`  ${APPLY ? "+" : "~"} ${f.facilityID} (${f.facilityName}): ` +
                `${JSON.stringify(cur)} -> ${JSON.stringify(after)}`);
    if (!APPLY) continue;

    await raw({ update: "FacilityAccess", updates: [{
      q: { facilityID: f.facilityID },
      u: {
        $set:         { requiredRoles: after, updatedAt: now(), updatedBy: ACTOR },
        // Legacy mirror on NEW rows only. "" is falsy, so the still-deployed
        // access.ts:36-39 treats them as open — today's behaviour. Existing rows
        // keep whatever they have (SCRC keeps "jcrc" and stays gated).
        $setOnInsert: { requiredRole: "" },
      },
      upsert: true,
    }]});
    await audit({ targetFacilityID: f.facilityID, action: "facilityAccess.set",
                  rolesBefore: cur, rolesAfter: after, reason: "RBAC v2 seed" });
  }

  // [4] cca_head: report only. No headship data exists to derive from.
  console.log(`\n[4] cca_head: NOT derivable. CCA and UserCCA are validator-guarded and`);
  console.log(`    neither has a head/position column. Grant explicitly via /admin;`);
  console.log(`    every grant also writes a CcaHead row (see 07-cca-future.md).`);
  console.log(`    CCAs: ${await db.cCA.count()}, UserCCA memberships: ${await db.userCCA.count()}`);

  // [5] VERIFY
  console.log(`\n=== VERIFY ===`);
  const rows   = (await raw({ find: "UserRole", filter: {}, batchSize: 1000 }))?.cursor?.firstBatch ?? [];
  const admins = rows.filter((d) => (d.roles ?? []).includes("admin")).map((d) => d.userID);
  const jcrcN  = rows.filter((d) => (d.roles ?? []).includes("jcrc")).length;
  const noArr  = rows.filter((d) => !Array.isArray(d.roles));
  const noLeg  = rows.filter((d) => d.role === undefined);
  console.log(`admins: ${admins.join(", ") || "(NONE)"}`);
  console.log(`jcrc holders: ${jcrcN}`);
  console.log(`UserRole rows missing roles[]:        ${noArr.length}`);
  console.log(`UserRole rows missing legacy 'role':  ${noLeg.length}`);

  const fa = (await raw({ find: "FacilityAccess", filter: {}, batchSize: 1000 }))?.cursor?.firstBatch ?? [];
  for (const d of fa) console.log(`  facility ${d.facilityID}: ${JSON.stringify(d.requiredRoles ?? null)} ` +
                                  `(legacy ${JSON.stringify(d.requiredRole ?? null)})`);
  const uncovered = facilities.filter((f) => !fa.some((d) => d.facilityID === f.facilityID));
  const badLegacy = fa.filter((d) => d.requiredRole === undefined);
  const hasAdmin  = fa.filter((d) => (d.requiredRoles ?? []).includes("admin"));
  console.log(`facilities WITHOUT a FacilityAccess row: ${uncovered.length}`);
  console.log(`FacilityAccess rows missing legacy 'requiredRole': ${badLegacy.length}`);
  console.log(`FacilityAccess rows storing "admin" (must be 0): ${hasAdmin.length}`);

  if (APPLY) {
    const fail = (m) => { console.error(`*** VERIFY FAILED: ${m} ***`); process.exitCode = 1; };
    if (!admins.includes(ADMIN_USER_ID)) fail(`${ADMIN_USER_ID} is not admin`);
    if (noArr.length)     fail(`${noArr.length} UserRole row(s) missing roles[]`);
    if (noLeg.length)     fail(`${noLeg.length} UserRole row(s) missing legacy 'role' (I-2)`);
    if (uncovered.length) fail(`${uncovered.length} facility/facilities with no access row`);
    if (badLegacy.length) fail(`${badLegacy.length} FacilityAccess row(s) missing legacy scalar (I-2)`);
    if (hasAdmin.length)  fail(`${hasAdmin.length} FacilityAccess row(s) store "admin"`);

    // Stored-baseline pre-check. NOT a fail here: this script runs BEFORE
    // Step 12, so the admin and the 11 jcrc holders legitimately have no
    // "resident" yet. Name them so that if Step 12 then reports a gap, you can
    // tell "Step 12 missed them" from "they were never eligible". Step 12's own
    // VERIFY is the blocking gate.
    const noResident = rows.filter((d) => !(d.roles ?? []).includes("resident")).map((d) => d.userID);
    console.log(`UserRole rows without stored resident (expected until Step 12): ` +
                `${noResident.length}${noResident.length ? ` — ${noResident.join(", ")}` : ""}`);
  }
}

main().then(() => console.log("\nDone."))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
```

```bash
node scripts/remediation/seed-roles-v2.mjs
APPLY=yes node scripts/remediation/seed-roles-v2.mjs
node scripts/remediation/seed-counters.mjs
```

**Review the dry run before applying.** Confirm the admin id, the roster length, and — most importantly — that every facility's `-> [...]` line matches the reviewed `facility-roles.json` classification. This is the last human checkpoint on the room gating.

Immediately after applying, assert the **currently deployed** client can still read:

```bash
node -e "import('@prisma/client').then(async({PrismaClient})=>{const d=new PrismaClient();
const fa=await d.facilityAccess.findMany();
console.log('rows:',fa.length,'all legacy falsy or preserved:',fa.every(r=>typeof r.requiredRole==='string'));
await d.\$disconnect();})"
```

---

## Step 12 — Backfill `resident` (AUTHORITATIVE)

`scripts/remediation/backfill-resident.mjs`. Iterates **`User`**, not `UserRole`.

```js
/**
 * Grants the stored `resident` baseline on UserRole for every eligible User.
 *
 * AUTHORITATIVE. `resident` is a stored role (section 0.1); nothing derives it.
 * An id this run misses holds NO baseline and cannot book a normal room until
 * ensureBaseline() repairs it at that user's next session read (I-8b). A
 * partial run is therefore a REAL, if self-healing, lockout for the ids it
 * missed — not a visibility gap. Three consequences that shape this script:
 *   - the VERIFY pass below re-reads what is actually stored and NAMES every
 *     missing id (I-16); it exits 1 on a non-empty set, so it can gate a script;
 *   - re-running the script IS the resume — every write is $addToSet + upsert,
 *     so it is idempotent and order-independent (ordered:false);
 *   - ONLY=<file> reprocesses just the previous run's misses.
 *
 * Eligibility is isResidentEligible(canonicalUserID(email)) — the shared
 * predicate (I-12), NEVER E_FORMAT. g.s_samuel@u.nus.edu is a real eligible
 * account in this database and an E-format gate here would withhold its
 * baseline permanently, not merely mis-derive it once (L-27, Step 2).
 *
 *   node scripts/remediation/backfill-resident.mjs
 *   APPLY=yes node scripts/remediation/backfill-resident.mjs
 *   APPLY=yes ONLY=backups/resident-backfill-missing.json node ...   # resume
 *
 * MUST run AFTER Step 8 (the push that made the legacy scalars optional).
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { canonicalUserID, isResidentEligible } from "./lib/identity.mjs";

const db = new PrismaClient();
const APPLY = process.env.APPLY === "yes";
const ONLY = process.env.ONLY;            // resume file from a previous VERIFY
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (cmd) => db.$runCommandRaw(cmd);

// 1. Drain User via a raw cursor, projecting ONLY _id + email. A row missing
//    the required passwordHash scalar (schema.prisma:353) would throw a typed
//    read — this is why the whole script is $runCommandRaw.
async function findAll(collection, projection) { /* getMore loop, as Step 3 */ }
const users = await findAll("User", { _id: 1, email: 1 });

// 2. Derive, classify, DEDUPE. Two User rows collapsing to one canonical id is
//    the merged-account case — report it, never silently pick one. Under a
//    STORED baseline a collision is not cosmetic: one of two merged humans
//    silently gets nothing, so the collision block below still exits 1.
//    Eligibility is derived from the EMAIL every time — the predicate is a
//    post-canonicalization sanity check, never a provenance test, so it is only
//    sound on a value canonicalUserID() just produced (I-8d).
const seen = new Map(), ineligible = [], collisions = [];
for (const u of users) {
  const id = canonicalUserID(u.email);
  if (!isResidentEligible(id)) { ineligible.push({ _id: u._id, email: u.email }); continue; }
  if (seen.has(id)) collisions.push({ id, emails: [seen.get(id), u.email] });
  else seen.set(id, u.email);
}
console.log(`eligible ${seen.size}  ineligible ${ineligible.length}  collisions ${collisions.length}`);
mkdirSync(join(HERE, "backups"), { recursive: true });
writeFileSync(join(HERE, "backups", "resident-backfill-plan.json"), JSON.stringify(
  { at: new Date().toISOString(), eligible: [...seen.keys()], ineligible, collisions }, null, 2));

if (collisions.length) {
  console.error("*** canonical id collisions present — resolve before applying (Step 3) ***");
  process.exitCode = 1;
}

// 3. Batched upsert + $addToSet. Idempotent and order-independent, so an
//    interrupted run is simply re-run; the plan file above is the ledger.
//    $setOnInsert writes the legacy scalar as "" (I-9 — empty string, never
//    null, never "user") so the deployed old client can read these ~504 new
//    documents (I-2) and reads them as no-role. That sentinel is on a HOTTER
//    path than it was in v1: ensureBaseline() writes the same shape at runtime,
//    so `role String?` in the Step 7 push is doubly non-negotiable.
//    ordered:false — one failing statement must not abort the batch.
//
//    $runCommandRaw does NOT throw on a per-write failure: the update command
//    resolves with { ok: 1, n, nModified, upserted, writeErrors: [...] }. Read
//    the reply. A batch whose writeErrors are ignored reports success while
//    leaving users with no baseline.
let nModified = 0, nUpserted = 0;
const writeErrors = [];
const ids = ONLY
  ? JSON.parse(readFileSync(join(HERE, ONLY), "utf8")).missing.filter((id) => seen.has(id))
  : [...seen.keys()];
for (let i = 0; i < ids.length && APPLY; i += 200) {
  const res = await raw({ update: "UserRole", ordered: false, updates: ids.slice(i, i + 200).map((userID) => ({
    q: { userID },
    u: { $addToSet: { roles: "resident" }, $setOnInsert: { role: "", pendingCheckedAt: { $date: new Date().toISOString() } } },
    upsert: true,
  }))});
  nModified += Number(res?.nModified ?? 0);
  nUpserted += (res?.upserted ?? []).length;
  if (res?.writeErrors?.length) writeErrors.push(...res.writeErrors);
}
console.log(`modified ${nModified}  upserted ${nUpserted}  writeErrors ${writeErrors.length}`);
if (writeErrors.length) {
  console.error("*** WRITE ERRORS:", JSON.stringify(writeErrors.slice(0, 20), null, 2));
  process.exitCode = 1;
}

// 4. VERIFY — a SET DIFFERENCE against what is actually stored, not a count of
//    what we believe we wrote. Re-read UserRole, compute eligible \ have, and
//    NAME the offenders (I-16). A count can match by coincidence; a difference
//    cannot. Runs in dry-run mode too, so it doubles as a standing audit.
const stored = await findAll("UserRole", { userID: 1, roles: 1 });
const have = new Set(stored.filter((r) => (r.roles ?? []).includes("resident")).map((r) => r.userID));
const missing = [...seen.keys()].filter((id) => !have.has(id));
writeFileSync(join(HERE, "backups", "resident-backfill-missing.json"),
  JSON.stringify({ at: new Date().toISOString(), missing }, null, 2));

const noLegacy = (await raw({ count: "UserRole", query: { role: { $exists: false } } })).n;
console.log(`eligible ${seen.size}  materialized ${have.size}  MISSING ${missing.length}`);
console.log(`UserRole rows missing legacy 'role' (must be 0): ${noLegacy}`);
if (missing.length) {
  console.error("*** MISSING (no stored resident — these users cannot book until they log in again):",
                missing.join(", "));
  console.error(`*** resume with: APPLY=yes ONLY=backups/resident-backfill-missing.json node ${"" /* this script */}`);
  process.exitCode = 1;
}
if (noLegacy) process.exitCode = 1;
```

```bash
node scripts/remediation/backfill-resident.mjs
APPLY=yes node scripts/remediation/backfill-resident.mjs
# if it exits 1 with a MISSING list, fix the cause and resume:
APPLY=yes ONLY=backups/resident-backfill-missing.json node scripts/remediation/backfill-resident.mjs
```

**This script must exit 0 before Phase 2 enforcement is flipped past `off`.** A non-empty `MISSING` set is a live lockout list, not a reporting gap: those users hold no baseline and are denied on **every** normal room (the D-1 default is `["resident"]`) until their next session read repairs them. `rbac-doctor.mjs` carries the same check as a red line so the condition is detected even if nobody re-runs this script.

Note the `pendingCheckedAt` stamp in `$setOnInsert`. It puts the entire existing population directly on the fast path of the login-time grant applier (`02-backend-authz.md`), so the first `/api/auth/session` read after deploy does **no** extra `PendingRoleGrant` lookup and **no** write for ~515 users at once.

Then confirm the deployed client still reads the new documents:

```bash
node -e "import('@prisma/client').then(async({PrismaClient})=>{const d=new PrismaClient();
console.log('UserRole readable:', (await d.userRole.findMany()).length); await d.\$disconnect();})"
```

---

## Step 12b — Re-run the backfill immediately before the enforcement flip

Anyone who signed up between Step 12 and the `permissive` → `enforce` flip must already hold the baseline from their creation-time grant (`02-backend-authz.md`: the register route and the NextAuth `events.createUser` hook). This step proves it.

```bash
APPLY=yes node scripts/remediation/backfill-resident.mjs
```

Required output: **`MISSING 0`** *and* **`modified 0  upserted 0`**.

Both numbers matter, and `MISSING 0` alone is not sufficient. The script `$addToSet`s every eligible id unconditionally, so once the write lands the set difference is 0 whether or not the creation-time grants work — the only observable difference between "the grant points work" and "the grant points are broken and this script just papered over them" is that `modified`/`upserted` are non-zero. **If either is non-zero, a grant point is missing or failing: block the flip and find out which one before continuing.** That is the whole reason those two counters are accumulated from the raw command replies in Step 12 rather than inferred from the command succeeding.

---

## Step 13 — Set the enforcement flag to `off` before any code ships

`scripts/remediation/set-enforcement.mjs`:

```js
// node scripts/remediation/set-enforcement.mjs off|permissive|enforce
const MODE = process.argv[2];
if (!["off", "permissive", "enforce"].includes(MODE)) throw new Error("mode must be off|permissive|enforce");
await db.$runCommandRaw({ update: "SystemFlag", updates: [{
  q: { key: "rbac.booking.enforcement" },
  u: { $set: { key: "rbac.booking.enforcement", value: MODE,
               updatedAt: { $date: new Date().toISOString() }, updatedBy: "script:set-enforcement" } },
  upsert: true,
}]});
```

```bash
node scripts/remediation/set-enforcement.mjs off
```

Do this **before** Phase 2 deploys, so the new default-deny code lands inert and the rollout is a data-only flip afterwards. `02-backend-authz.md` owns the semantics of the three modes; `05-verification.md` owns the shadow-soak protocol. Also add `RBAC_BOOKING_ENFORCEMENT: z.enum(["off","permissive","enforce"]).default("off")` to `src/env.js` — that is the deploy-level floor so a wiped `SystemFlag` collection cannot silently enforce.

---

## Step 14 — `rbac-doctor.mjs`

`scripts/remediation/rbac-doctor.mjs`. Read-only, safe to run any time, exits 1 on any red line. This is the detection query the impact report notes is missing everywhere; it is also surfaced as an `/admin` health panel (`03-admin-dashboard.md`), with **per-user identifier lists for admin only** and aggregate counts for jcrc.

```
users(total) ................................. 517
users(eligible, canonical has no @) .......... 515
users(INELIGIBLE — cannot sign in under D-7) .   2   <- Step 3 migration list
canonical id collisions ......................   0   <- merged accounts
canonical id empty (blank email) .............   0
canonical id not E-format ....................   3   <- INFORMATIONAL, not a fault
UserRole rows with stored resident ........... 515
  eligible users MISSING it ..................   0   <- RED. Live lockout list;
                                                     names the ids. Blocks the
                                                     flip past `off`.
UserRole rows missing roles[] ................   0
UserRole rows missing legacy 'role' ..........   0   <- I-2, blocks Phase 2 deploy
UserRole rows keyed on a non-canonical id ....   0   <- I-1
UserRole duplicate userID rows ...............   0   <- unique index actually built?
User rows missing passwordHash ...............   0   <- gates the session change
orphans under the OLD key (Bookings/UserCCA/
  UserMatric/UserRole) .......................   0   <- Step 4, blocks deploy
facilities (excl. -1) ........................  12
  with a FacilityAccess row ..................  12
  UNCONFIGURED ...............................   0   <- would default to resident
  storing "admin" in requiredRoles ...........   0
FacilityAccess rows missing legacy scalar ....   0   <- I-2
PendingRoleGrant: outstanding ................   0
  of which admin/jcrc ........................   0   <- requires named sign-off
  expired, unclaimed .........................   0
enforcement mode ............................. off
shadow denials, last 24h .....................   0   <- go/no-go for `enforce`
```

Run it daily through the rollout. The three lines that gate the enforcement cutover are **`eligible users MISSING it`**, **`UNCONFIGURED`** and **`shadow denials, last 24h`**; the three that gate the Phase 2 *deploy* are the two `missing legacy` lines and `orphans under the OLD key`.

The `eligible users MISSING it` line must be computed over `User` rows whose email matches the NUS regex **only**. Counting non-NUS rows there makes it a line that can never reach zero, and a gate that can never reach zero gets commented out — which deletes the detector.

---

## Step 15 — Smoke tests

```bash
# multikey `has` filter
node -e "import('@prisma/client').then(async({PrismaClient})=>{const d=new PrismaClient();
console.log('admins:',   await d.userRole.count({where:{roles:{has:'admin'}}}));
console.log('jcrc:',     await d.userRole.count({where:{roles:{has:'jcrc'}}}));
console.log('resident:', await d.userRole.count({where:{roles:{has:'resident'}}}));
await d.\$disconnect();})"
```

Expect `admins: 1`, `jcrc: 11` (or your roster size), `resident: <eligible count from Step 12>`. If `has` misbehaves, note it — `02-backend-authz.md`'s last-admin guard and `03-admin-dashboard.md`'s role filter both depend on it, and the fallback is an in-memory filter over the small collection.

```bash
node scripts/remediation/rbac-doctor.mjs
```

Every line green except `enforcement mode: off`.

---

## `cca_head` and existing CCA data — the honest answer

`cca_head` **cannot** be derived or migrated from existing data. Verified directly against the schema:

- `CCA` (`prisma/schema.prisma:120-126`) has `{ id, category, ccaID, ccaName }` — no head, owner, or contact field.
- `UserCCA` (`:364-369`) has `{ id, ccaID, userID }` — a bare join, no position column, no compound unique, no timestamp.
- Both carry the `$jsonSchema` doc comment, so `isHead` cannot be added to either.

There is no signal to infer from, not even a weak one like "first member added" — no timestamp exists. Any heuristic would be fabricating role grants, which is the one category of error this system must not make.

Path forward, all of which `07-cca-future.md` owns:

1. `cca_head` is granted explicitly, through `/admin`. Under D-1 it now confers real booking capability over every CCA-gated room, with **deliberately no per-CCA ownership check this phase**.
2. Every `cca_head` grant writes a `CcaHead { userID, ccaID }` row **in the same transaction**. `CcaHead` is the source of truth for scope; the flat `"cca_head"` string in `UserRole.roles` is a derived capability cache. You can always ignore data you have; you can never recover data you did not write.
3. `CcaHead` is **not consulted** by the booking path in this phase. The single function that will start consulting it is `canBookWithRoles` in `src/server/api/services/access.ts`, via an added optional `ccaID` parameter.
4. Adjacent seam, recorded not fixed: `createBooking` accepts `ccaID` from the client with no membership check (`src/server/api/routers/facilitiesBooking.ts:296`, written at `:360`; `BookingModal.tsx:92` hardcodes `ccaID: 0`). Under D-1 a legitimate `cca_head` can therefore book a CCA room and attribute it to a CCA they have nothing to do with. **One cheap half is worth taking now** and belongs to `07-cca-future.md`: assert `ccaID === 0 || a CCA row exists`, because `deleteCcaCascade` (`src/server/api/services/cascade.ts:28`) deletes `Bookings` by `ccaID`, so a forged ccaID makes unrelated bookings collateral damage. Confirm no `CCA` row has `ccaID: 0` (the Step 5 query checks this) and reserve 0 as "no CCA".

---

## Legacy scalar removal

**Not in this phase.** `role` and `requiredRole` remain, optional, dual-written. The drop is a one-way door requiring a dual-write soak window, a containment verification, a fresh backup and a tested restore — all of which live in `06-legacy-cutover.md`. Do not bundle it here, and do not run any `$unset` from this document.

---

## Done when

**Safety and census**
- [ ] `.gitignore` contains `/scripts/remediation/backups/` and `/scripts/remediation/data/`, and `git log --all -- scripts/remediation/backups/` is empty.
- [ ] Backups taken (Atlas snapshot **or** the JSON dumps, with the cluster tier confirmed either way).
- [ ] `verify-admin-id.mjs` printed the expected canonical userID, non-empty (D-4 answered).
- [ ] `identity.parity.test.mjs` passes: `scripts/remediation/lib/identity.mjs` agrees with `src/lib/identity.ts` on every fixture, including `g.s_samuel@u.nus.edu`.
- [ ] `census-identity.mjs` run; the non-NUS list, `missingPasswordHash`, `plusAddressed`, `whitespaceEmails` and collision counts have each been triaged with the user and acted on.
- [ ] `verify-canonical-rekey.mjs` prints **zero orphans** across `Bookings`, `UserCCA`, `UserMatric` and `UserRole`.

**Data model**
- [ ] `backfill-roles-v2.mjs` VERIFY reports 0 rows missing `roles[]` / `requiredRoles[]`, and it created no documents.
- [ ] `prisma db push` completed with **no** `--accept-data-loss` prompt; `prisma generate` and `tsc --noEmit` clean.
- [ ] `prisma/schema.prisma` has `UserRole.role String?` and `FacilityAccess.requiredRole String?` — **optional**, not required.
- [ ] Atlas shows `UserRole.roles_multikey`, `RoleAuditLog` with five indexes, `UserMatric.matric`, and the collections `PendingRoleGrant`, `BulkRoleImport`, `SystemFlag`, `CcaHead`.
- [ ] `passwordHash` made optional **iff** the census showed rows missing it.

**Seeding**
- [ ] `seed-rbac.mjs` is **deleted**; its counter logic lives in `seed-counters.mjs` and its 11 ids in `data/jcrc-users.json`; `README.md` updated.
- [ ] `data/facility-roles.json` exists, is keyed on `facilityID`, excludes `-1`, contains no `"admin"`, and has been reviewed by a second person.
- [ ] `seed-roles-v2.mjs` VERIFY shows your userID under `admins`, the expected `jcrc` count, **`facilities WITHOUT a FacilityAccess row: 0`**, and 0 rows missing either legacy scalar.
- [ ] Atlas: SCRC's `FacilityAccess` row has `requiredRoles: ["jcrc"]` **and** still has its original `requiredRole: "jcrc"` untouched.
- [ ] Every other facility has an explicit `requiredRoles` row; newly created rows have `requiredRole: ""`.
- [ ] `RoleAuditLog` contains one row per grant and per facility set, actor `system:seed-roles-v2`.
- [ ] `seed-counters.mjs` run; `Counter.bookingID` seeded.

**Resident backfill (AUTHORITATIVE)**
- [ ] `backfill-resident.mjs` **exits 0** and reports `MISSING 0`, `writeErrors 0`, `collisions 0`, and `rows missing legacy 'role': 0`.
- [ ] `backups/resident-backfill-plan.json` exists and lists every eligible id plus the ineligible and collision sets.
- [ ] `backups/resident-backfill-missing.json` exists and its `missing` array is **empty**.
- [ ] Eligibility came from `isResidentEligible(canonicalUserID(email))`, not from `E_FORMAT` — spot-check that a non-E-format eligible id (e.g. `G.S_SAMUEL`) holds `resident` (L-27).
- [ ] Every backfilled row carries `pendingCheckedAt`.
- [ ] Step 12b re-run, immediately before the flip past `off`, printed `MISSING 0` **and** `modified 0  upserted 0`.

**Regression guard — booking behaviour is unchanged by Phase 1**
- [ ] A typed `db.userRole.findMany()` and `db.facilityAccess.findMany()` against the **currently deployed** Prisma client both succeed after Step 11 and after Step 12.
- [ ] A non-admin account with a newly created `UserRole` row can still load the calendar (`getBookings`) and still book a normal room — i.e. `getUserRole` did not start throwing.
- [ ] SCRC is still bookable only by the same people as before the phase.

**Flags and detection**
- [ ] `SystemFlag{ key: "rbac.booking.enforcement", value: "off" }` exists **before** any Phase 2 code deploys.
- [ ] `RBAC_BOOKING_ENFORCEMENT` added to `src/env.js` with default `"off"`.
- [ ] `rbac-doctor.mjs` exits 0 with every line green except `enforcement mode: off`.
- [ ] The `has` smoke test returns the expected `admin` / `jcrc` / `resident` counts.
- [ ] `backups/roles-v2-pre-backfill.json` exists and contains every pre-migration row.