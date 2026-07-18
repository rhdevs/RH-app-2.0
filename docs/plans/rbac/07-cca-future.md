> **Status:** forward-design + one shippable feature (`transferCcaHead`).
> **Depends on:** `01-data-model.md` (CcaHead model), `02-backend-authz.md` (role vocabulary, G1–G7 guards), `06-legacy-cutover.md` (legacy scalar dual-write window).
> **Owns:** the `CcaHead` collection, the three `admin.*CcaHead` procedures, the `UserCCA` index work, and the CCA-related edits to `02`/`03`/`05`.

This document does **not** build the CCA management system. It does two things:

1. Fixes the **data shape** now so that when CCA management arrives, nothing written in this phase has to be migrated away from.
2. Ships **role handover** — because handover is the one piece that is cheap now and expensive later.

---

## 0. Ground truth, verified against the repo

All of the following was read directly from source in this pass. Line numbers are current as of writing.

### 0.1 The two CCA models

```prisma
/// This collection uses a JSON Schema defined in the database...
model CCA {                                   // prisma/schema.prisma:120-126
  id       String @id @default(auto()) @map("_id") @db.ObjectId
  category String
  ccaID    Int    @unique(map: "ccaID")
  ccaName  String
}

/// This collection uses a JSON Schema defined in the database...
model UserCCA {                               // prisma/schema.prisma:362-366
  id     String @id @default(auto()) @map("_id") @db.ObjectId
  ccaID  Int
  userID String
}
```

| Fact | Consequence |
|---|---|
| `CCA` has **no** head / owner / contact / advisor field | A head cannot be read off the CCA document. |
| `UserCCA` has **no** position / `isHead` column | Membership is flat; heads are indistinguishable from members. |
| `UserCCA` has **no timestamp** | Even the weak heuristic "earliest member = head" is unavailable. |
| `UserCCA` has **no compound unique** on `[ccaID, userID]` | Duplicate membership rows are possible and may already exist. |
| Both carry the `$jsonSchema` doc comment | Per the standing invariant, **no new field** on either. `isHead` on `UserCCA` is impossible. |
| `CCA.ccaID` is `@unique`; `UserCCA.ccaID` has **no index** | "List this CCA's members" is a collection scan today. |

**How a CCA head could be identified today: it cannot.** There is no signal, not even a weak one. `01-data-model.md`'s "cca_head and existing CCA data — the honest answer" section reaches this conclusion and it is **correct; keep it verbatim.** Any heuristic would be fabricating role grants.

### 0.2 No code writes CCA data

The only references to `UserCCA` in `src/` are two deletes, in `src/server/api/services/cascade.ts:27` and `:38`. There is no CRUD surface at all. CCA management is entirely greenfield — which is why getting the shape right now costs nothing.

`Posts` (`prisma/schema.prisma:274`) has `ccaID`, `isOfficial`, `userID`, but `src/server/api/routers/post.ts` implements nothing CCA-related: `create` (`post.ts:22`) is gated on `matricProcedure` but returns `null`. CCA posts are greenfield for authz too.

### 0.3 BLOCKING PREREQUISITE — what identifier format is in `UserCCA.userID`?

**This is unresolved and it gates C-3 and the whole future CCA system.** Atlas refused connection from the authoring environment (`ReplicaSetNoPrimary`, server-selection timeout — the IP is not allowlisted), so it must be run by the user.

The suspicion is concrete and comes from the code, not from guessing. `cascade.ts:33-43` uses **one** `userID` string to delete from `Bookings`, `Posts`, `Order`, `UserCCA`, `Gym`, **and** `User`:

```ts
export async function deleteUserCascade(db: PrismaClient, userID: string) {
  return db.$transaction(async (tx) => {
    await tx.bookings.deleteMany({ where: { userID } });   // E-format (session-derived)
    await tx.posts.deleteMany({ where: { userID } });
    await tx.order.deleteMany({ where: { userID } });
    await tx.userCCA.deleteMany({ where: { userID } });    // ?? unknown
    await tx.gym.deleteMany({ where: { userID } });
    return tx.user.deleteMany({ where: { userID } });      // A-format matric (I-1)
  });
}
```

`Bookings.userID` is written from `session.user.userID` (E-format). `User.userID` holds an A-format matric in ~515 rows (invariant I-1). **These two cannot both be right**, so `cascade.ts` already contains a latent key-format bug and `UserCCA` sits on the wrong side of it.

**Step 0 — run this and record the output before any other step in this document:**

```bash
node -e "import('@prisma/client').then(async({PrismaClient})=>{const d=new PrismaClient();
const all = await d.userCCA.findMany({select:{ccaID:true,userID:true}});
console.log('total UserCCA:', all.length);
console.log('E-format:', all.filter(r=>/^E\d{7}$/i.test(r.userID)).length);
console.log('A-format:', all.filter(r=>/^A\d{7}[A-Z]$/i.test(r.userID)).length);
console.log('other:',     all.filter(r=>!/^E\d{7}$/i.test(r.userID)&&!/^A\d{7}[A-Z]$/i.test(r.userID)).length);
const seen=new Set(), dup=[];
for(const r of all){const k=r.ccaID+'|'+r.userID; if(seen.has(k))dup.push(k); seen.add(k);}
console.log('duplicate (ccaID,userID) pairs:', dup.length, dup.slice(0,20));
// C-2b: does a CCA with ccaID 0 exist? See section 5.
console.log('CCA ccaID=0:', JSON.stringify(await d.cCA.findFirst({where:{ccaID:0}})));
console.log('sample:', JSON.stringify(all.slice(0,10)));
await d.\$disconnect();})"
```

**Gate:** if `A-format > 0` or `other > 0`, **stop and do not run C-3.** Every future CCA feature then needs a matric→canonical translation layer; `UserMatric` (`prisma/schema.prisma:266-271`) is the only bridge and its `matric` field has **no unique index**, so the join is not guaranteed 1:1. Deduping on a misunderstood identity key is unrecoverable in a way the missing index is not.

`CcaHead` is unaffected by this unknown — it is a new collection and this document keys it on the canonical E-format id unconditionally (C-1).

---

## 1. C-1 — Store the scope from day one, in `CcaHead`, not in `UserRole.roles`

**This is the key forward-design decision.**

> **Recommendation (decisive):** keep `UserRole.roles` a flat `String[]` containing the plain string `"cca_head"`, **and** write a scoped `CcaHead { userID, ccaID }` row for every grant, in the same transaction. Ship both from day one. The booking path reads only the flat string and ignores scope — exactly as D-1 chose.

### 1.1 Why not put scope in `UserRole.roles`

Reject the shape `{ role: "cca_head", ccaID: 12 }` inside the roles array:

- **It breaks I-2 head-on.** `UserRole.roles` would go from `String[]` to a composite-type list on an already-populated collection — precisely the class of change Prisma 6's Mongo connector throws on when reading. The role read sits in the session callback (`src/server/auth.ts:132-154`), so the failure mode is *nobody can log in*.
- **It contaminates the escalation firewall.** `ASSIGNABLE_BY` / `REVOCABLE_FROM_OTHERS_BY` (`02-backend-authz.md:49-69`) are `Record<string, readonly GrantableRole[]>` with a null prototype, specifically so an unvalidated string cannot reach `Object.prototype`. Composite roles force parsing at every one of G1–G7. Adding an object-shaped key to a firewall whose premise is "policy as data, not if-statements" is how that firewall stops being auditable.
- **It multiplies the highest-risk surface in the revision.** `normalizeStoredRoles` (`02-backend-authz.md`, formerly `effectiveRoles`) is the single read boundary for the stored array, and the same array is now the storage site of the auto-assigned `resident` baseline (I-8). Making it heterogeneous while simultaneously making it the authoritative home of the baseline is the wrong two changes to combine.
- **`session.user.roles` is render-only (I-5).** Scope in the session buys nothing — every authoritative check re-reads from the DB, and that re-read can hit `CcaHead` directly.
  > **Honest correction under the stored-`resident` revision.** The earlier draft of this bullet also argued *"`roles` is render-only anyway, so there is nothing to be gained by enriching it."* That argument is **dead**: `UserRole.roles` is now genuinely authoritative persisted state, not a materialization of something derivable. The *session copy* is still render-only, which is all this bullet now claims. The rejection of composite entries stands on the other two arguments — the I-2 breakage and the guard-map contamination — which are independent of derivation and unaffected by the revision. Recorded rather than quietly deleted, so nobody rediscovers the retired rationale and mistakes it for a live one.
- **`CcaHead` already exists in the approved plan** with the right shape.

The user's choice ("any `cca_head` books any CCA room") is a **policy** decision. Storing scope is a **data** decision. Conflating them is exactly what would force a migration later: *you can always ignore data you have; you can never recover data you did not write.*

### 1.2 The model — keep as approved, change only the comment

`01-data-model.md` currently declares:

```prisma
model CcaHead {
  id        String   @id @default(auto()) @map("_id") @db.ObjectId
  userID    String
  ccaID     Int
  grantedAt DateTime @default(now())
  grantedBy String?

  @@unique([userID, ccaID], map: "user_cca_head")
  @@index([ccaID], map: "ccaID")
}
```

**Keep the model unchanged.** Edit only the doc comment, which currently says "Defined now, populated later". Replace with:

```
/// Which CCA(s) a user heads. `cca_head` CANNOT be derived from existing data:
/// CCA and UserCCA are BOTH validator-guarded and neither has a head/position
/// column, so an `isHead` field is impossible (see 07-cca-future.md §0.1).
///
/// SOURCE OF TRUTH for cca_head. Populated FROM THE FIRST GRANT, not later.
/// The "cca_head" string in UserRole.roles is a derived capability cache;
/// invariant CH-1 in 07-cca-future.md §1.3 binds the two.
///
/// DELIBERATELY NOT CONSULTED by the booking path in this phase (decision D-1:
/// any cca_head may book any CCA-gated room). The single function that will
/// start consulting it is `canBookWithRoles` in
/// src/server/api/services/access.ts — adding an optional `ccaID?: number`
/// parameter there is the ONLY edit required to make cca_head scoped.
```

Naming the exact future edit site is what makes this a non-migration rather than a deferral.

`userID` on this collection is **always** the canonical userID produced by `canonicalUserID(email)` in `src/lib/identity.ts` (invariant I-1) — **not** necessarily an E-format id. Reuse the one shared eligibility predicate (invariant I-12) rather than re-deriving a rule here:

```ts
// src/server/api/services/roles.ts — export, reused by every CcaHead write
// `isResidentEligible` is defined in this same file (02-backend-authz.md Step 3.1)
// and is THE single eligibility predicate (invariant I-12).

/**
 * A canonical userID as produced by canonicalUserID(email) in
 * src/lib/identity.ts: the uppercased localpart of an @u.nus.edu address.
 *
 * DO NOT constrain this to /^E\d{7}$/. Non-E-format @u.nus.edu localparts are
 * REAL in this database — `g.s_samuel@u.nus.edu` canonicalises to "G.S_SAMUEL"
 * (scripts/remediation/backups/merge-backup.json). E-format is a validation
 * rule for pasted grant targets only, never an eligibility gate. This is
 * lockout mode L-27 (`00-overview.md` §2.4); reintroducing the regex here
 * re-opens it.
 *
 * The blast radius of getting this wrong has GROWN under the stored-`resident`
 * revision: the same predicate now also gates the baseline WRITE (I-8d), so an
 * E-format regex would permanently withhold `resident` from `G.S_SAMUEL`-shaped
 * accounts rather than merely mis-deriving it on one read.
 *
 * Note also that this predicate is a post-canonicalization SHAPE check, never a
 * provenance test — see its definition in `roles.ts`. Passing it does not mean
 * the string came from a verified @u.nus.edu address.
 */
export const canonicalUserIDSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isResidentEligible, "not a canonical @u.nus.edu userID");
```

### 1.3 Invariant CH-1, and how it is made structural rather than aspirational

> **CH-1:** a user holds the `"cca_head"` string in `UserRole.roles` **if and only if** they have ≥ 1 `CcaHead` row.

A code contract alone is not enough — the generic role-mutation paths would break CH-1 on day one. `02-backend-authz.md:52-53` puts `"cca_head"` in `ASSIGNABLE_BY.admin` **and** `ASSIGNABLE_BY.jcrc`, `REVOCABLE_FROM_OTHERS_BY` grants it to both, `whoAmI().assignableRoles` surfaces it, and the D-8 bulk importer (`06`… no — `02`'s `commitBulkChunk`) resolves identifiers to roles **with no `ccaID` column at all**. A bulk grant of `cca_head`, or a `set` payload dropping it, produces string-without-scope / scope-without-string immediately.

**Make it impossible, not forbidden.** `cca_head` stays in the vocabulary but leaves the generic mutation surface:

1. **`02-backend-authz.md:49-69`** — remove `"cca_head"` from `ASSIGNABLE_BY.admin`, `ASSIGNABLE_BY.jcrc`, `REVOCABLE_FROM_OTHERS_BY.admin`, `REVOCABLE_FROM_OTHERS_BY.jcrc`. Note that `ASSIGNABLE_BY.jcrc` must independently become `[]` here: D-3 already removes `"jcrc"` from it (that edit is owned by `02`), and this document removes `"cca_head"`, so the entry empties out entirely. **Do not let that conflict get lost between the two docs — `02` owns the line, this doc owns the `cca_head` element.**
2. **Router-level rejection.** In `admin.grantRole` / `revokeRole` / `setUserRoles` / `commitBulkChunk` / `createPendingGrants`, reject the role explicitly so the failure is legible rather than a silent no-op:
   ```ts
   if (requested.includes(CCA_HEAD_ROLE)) forbid("USE_CCA_HEAD_ENDPOINT");
   ```
3. **Set-payload preservation — now by construction, not by union.** `setUserRoles` takes a *desired final set*. Since `cca_head` is no longer expressible in that payload, it must survive every write. Under the stored-`resident` revision the mechanism that protects the baseline has changed and `cca_head` inherits the stronger form: `applyRoleChange` no longer writes a set-payload at all. It writes `$pull(removed)` + `$addToSet(added)` where `removed ⊆ before ∩ GRANTABLE_ROLES`, and `cca_head` — like `resident` — is not in `GRANTABLE_ROLES` (item 1 removes it from `ASSIGNABLE_BY` / `REVOCABLE_FROM_OTHERS_BY`). So `cca_head` is not *unioned back after* being stripped; it is **incapable of entering the removal set in the first place** (invariant I-8c). Same chokepoint, therefore the same guarantee for `setUserRoles`, bulk import in both modes, bulk undo and deferred-grant redemption, with no per-caller memory required. Any residual sticky *list* in `assertCanMutateRoles` or in the `03` UI is a copy-consistency aid so the preview's `After` column matches what the server will do — it is no longer the mechanism.

   **Direction of truth (unchanged, and note it differs from `resident`).** `CcaHead` remains the sole source of truth for headship and `ccaHead.ts` the sole writer of the string (§2, invariant I-14); the stored `"cca_head"` string is a derived capability cache. This is deliberately *not* the relationship `resident` now has with its stored value — `resident` is authoritative data with no external source to reconcile against (I-8 as revised), whereas `cca_head` has `CcaHead` behind it. Do not let the `resident` revision be read as demoting `CcaHead`. If string and rows ever disagree, the CH-1 drift detectors (§7) fire and `CcaHead` wins; reconciliation is a `ccaHead.ts` re-grant/revoke, never a `setUserRoles` edit. Correspondingly there is **no** self-heal for `cca_head`: `ensureBaseline` tops up `resident` only, and must never be extended to synthesise `cca_head` from `CcaHead` rows on the session path.
4. **Bulk (D-8).** If bulk `cca_head` grants are required, the bulk row payload must carry `ccaID` and fan out to `grantCcaHead()`. A deferred/pending grant of `cca_head` must persist `{ role: "cca_head", ccaID }` and apply via `grantCcaHead` at redemption — or be rejected at import time. `PendingRoleGrant`'s flat `roles String[]` has no scope dimension, so **rejecting at import time is the correct default for this phase**; revisit when CCA management ships.
5. **`whoAmI().assignableRoles`** (`02-backend-authz.md:659-661`) drops `cca_head`; the CCA tab is driven by the separate `canManageCcaHeads` capability (§6).

### 1.4 C-2 — Freeze the role constant; forbid scope-in-the-string

- **Never encode scope in a role string.** `"cca_head:12"` must be impossible. The real guarantee is that `isGrantableRole` is a closed-whitelist membership test against `GRANTABLE_ROLES` — a string containing `:` can never pass it. **Do not add a `:`/`/` character check to `isGrantableRole`; it would be dead code presented as a security control.** Put the constraint where it can actually fail:
  - a unit test asserting `ROLES.every(r => /^[a-z_]+$/.test(r))`;
  - an assertion at the audit write that `rolesBefore`/`rolesAfter` ⊆ `ROLES` — that is the one place an out-of-vocabulary string could genuinely be persisted, since `RoleAuditLog` is a validator-free collection.
- **Reserve future names as comments only** in `roles.ts` — `cca_member` (a plain member with post rights). Do **not** add them to `ROLES`; an unused enum member is another read-boundary hazard.
- **Annotate `ASSIGNABLE_BY.cca_head: []`.** The impact report is right that leaving it unremarked is the defect:
  ```ts
  // A cca_head grants nothing. Succession is admin/jcrc-mediated via
  // admin.transferCcaHead (07-cca-future.md §4). Changing this to
  // ["cca_head"] would be the ONLY vocabulary edit needed for self-serve
  // handover, and it REQUIRES a per-object scope guard (caller heads THIS
  // ccaID) that does not exist: G1..G7 are role-scoped, not object-scoped.
  cca_head: [] as const,
  ```
  Those five lines are the whole forward-compatibility contract.

---

## 2. The write primitives — `src/server/api/services/ccaHead.ts` (NEW)

This file is the **only** writer of `CcaHead` and the **only** writer of the `"cca_head"` string. Three properties are load-bearing:

- **Guards live inside the functions, not at the call sites.** The signature requires the validated actor, so a future call site cannot skip the check.
- **Every `UserRole` write is `$addToSet` / `$pull` via `$runCommandRaw`, never a set-payload and never Prisma `push`.** Prisma Mongo `push` does not dedupe — heading a second CCA would produce `["cca_head","cca_head"]`, and the delta guard would then see a phantom removal on any unrelated save. `$addToSet` is also concurrency-safe and cannot clobber a role added by a parallel request.
- **`$setOnInsert: { role: "" }` on every upsert.** During the D-6 dual-write window (`06-legacy-cutover.md`) `UserRole.role` is a legacy scalar; a document inserted without it breaks typed reads on the session path (invariant I-2). The sentinel is the **empty string** — not `null`, not `"user"`: the still-deployed old client throws on absence *and* on `null`, while `""` is falsy and preserves the live open-by-default check (`01-data-model.md` §0.1). `$setOnInsert` leaves existing documents untouched, so this stays idempotent. Remove it in the same commit that drops the scalar. **Safe here specifically because neither write in this file `$set`s `role`** — MongoDB rejects an update whose `$set` and `$setOnInsert` name the same path (`ConflictingUpdateOperators`), which is why `applyRoleChange`, which *does* `$set` the legacy mirror, must carry no `$setOnInsert` on `role` at all. Do not copy this line into a write that mirrors the scalar.

`resident` needs **no** special handling here, but the reason has changed and is now load-bearing rather than incidental. Under the revised I-8 `resident` is a **stored** value in this very array, not a derived one — so "the read boundary will put it back" is no longer true, and a set-payload written from here would genuinely strip a user's baseline and lock them out of booking. What protects it is exactly the third bullet above: these primitives only ever `$addToSet` the one string they own and `$pull` the one string they own, so `resident` is never named in any payload they emit and cannot be removed by them. This is now the *primary* reason the primitives are `$addToSet`/`$pull` rather than read-modify-write, not merely a concurrency nicety. **Do not "simplify" either write into a `roles: [...]` set-payload** — the grep gate in `00-overview.md` §9 exists to catch that, and this file is in its scope.

```ts
// src/server/api/services/ccaHead.ts  (NEW FILE)
//
// INVARIANT CH-1: a user holds the "cca_head" string in UserRole.roles
//                 IFF they have >= 1 CcaHead row.
// Enforced here and NOWHERE else. No other module may write CcaHead or the
// "cca_head" string. See 07-cca-future.md §1.3.

import { CCA_HEAD_ROLE, assignableBy, revocableFromOthersBy } from "./roles";

type Actor = { userID: string; roles: readonly string[] };

/** Shared guard. Runs inside every grant/revoke/transfer. */
async function assertMayManageCcaHead(tx, actor: Actor, targetUserID: string) {
  // G-role: caller's role set must permit touching cca_head at all.
  if (!assignableBy(actor.roles).has(CCA_HEAD_ROLE)) forbid("CANNOT_GRANT_CCA_HEAD");
  // G3 target guard, shared implementation — do NOT hand-roll this check.
  await assertMayTouchTarget(tx, actor, targetUserID);
}

export async function grantCcaHead(tx, actor: Actor, { userID, ccaID }) {
  await assertMayManageCcaHead(tx, actor, userID);

  await tx.ccaHead.upsert({
    where:  { userID_ccaID: { userID, ccaID } },   // @@unique makes this atomic
    create: { userID, ccaID, grantedBy: actor.userID },
    update: {},                                    // idempotent re-grant
  });

  // $addToSet: idempotent, order-independent, cannot strip a concurrently
  // added role, and cannot strip the STORED `resident` baseline (I-8c) — it
  // names only CCA_HEAD_ROLE. $setOnInsert satisfies the D-6 legacy scalar
  // (drop it when 06 drops the field). Note this upsert can CREATE a UserRole
  // document for a user the backfill has not reached, so the row it inserts
  // holds ["cca_head"] and NOT `resident`; that is acceptable only because the
  // session-callback self-heal (I-8b) tops the baseline up before any
  // authoritative check consumes it. Do not add a `resident` $addToSet here —
  // `userID` on this path is admin/jcrc-supplied input with no verified NUS
  // provenance, and granting the baseline from it would violate I-8d.
  await tx.$runCommandRaw({
    update: "UserRole",
    updates: [{
      q: { userID },
      u: { $addToSet: { roles: CCA_HEAD_ROLE }, $setOnInsert: { role: "" } },
      upsert: true,
    }],
  });
}

export async function revokeCcaHead(tx, actor: Actor, { userID, ccaID }) {
  if (!revocableFromOthersBy(actor.roles).has(CCA_HEAD_ROLE) && actor.userID !== userID)
    forbid("CANNOT_REVOKE_CCA_HEAD");
  await assertMayTouchTarget(tx, actor, userID);

  await tx.ccaHead.deleteMany({ where: { userID, ccaID } });

  // Drop the capability string only when the LAST headship is gone.
  const remaining = await tx.ccaHead.count({ where: { userID } });
  if (remaining === 0) {
    // $pull, not a filtered read-modify-write: no-op on a missing document
    // (so it cannot throw P2025 and abort an enclosing transaction), and it
    // cannot clobber the rest of the array.
    await tx.$runCommandRaw({
      update: "UserRole",
      updates: [{ q: { userID }, u: { $pull: { roles: CCA_HEAD_ROLE } } }],
    });
  }
}
```

---

## 3. C-3 — `UserCCA` duplicate membership

`UserCCA` has no compound unique. The future CCA system's first screen is a roster, and a roster that double-lists people gets "fixed" with a client-side `.filter()` that then hides the real data problem.

**Key point: a `@@unique` index is not a schema-validator concern.** The `$jsonSchema` validator constrains *document shape* — which fields may exist and their bsonTypes. An index constrains *uniqueness across documents*. Adding `@@unique([ccaID, userID])` adds **no field**, so it does not violate the "no new fields on validator-guarded collections" invariant. This is genuinely available now, unlike `isHead`. Confirm against the D-5 `$jsonSchema` dump (`04-profile-page.md` step 0) before pushing.

The catch: `createIndex` **fails** if duplicates already exist. Ordered:

1. **Gate on §0.3.** If `UserCCA.userID` is not uniformly E-format, **stop** — defer this entire item.
2. Run the duplicate census (§0.3 query). If `0`, skip to step 5.
3. Back up: `mongodump --uri "$DATABASE_URL" --collection UserCCA --out scripts/remediation/backups/pre-usercca-dedupe`. This is a delete; it is one-way. Confirm `/scripts/remediation/backups/` is gitignored first — see `06-legacy-cutover.md`.
4. Dedupe, keeping the lowest `_id` per pair, dry-run by default:
   ```js
   // scripts/remediation/dedupe-usercca.mjs
   const res = await db.$runCommandRaw({ aggregate: "UserCCA", cursor: {}, pipeline: [
     { $group: { _id: { ccaID: "$ccaID", userID: "$userID" },
                 ids: { $push: "$_id" }, n: { $sum: 1 } } },
     { $match: { n: { $gt: 1 } } } ]});
   // APPLY=yes -> delete ids.slice(1) per group. Print every deletion.
   ```
5. Add to `prisma/schema.prisma` under `model UserCCA`:
   ```prisma
   @@unique([ccaID, userID], map: "cca_user")
   @@index([ccaID], map: "ccaID")   // roster reads are a collection scan today
   ```
6. **Do not run a standalone `prisma db push` here.** `db push` applies the *entire* schema delta, which in this release also carries the `UserRole` / `FacilityAccess` changes and the D-6 drops. Pulling it forward would violate the I-3 ordering (backfill → push → deploy) for those models. This index lands in the **single** `db push` scheduled in `01-data-model.md`; steps 1–4 must therefore complete before that push.

---

## 4. C-4 — `RoleAuditLog` gains a CCA dimension

`RoleAuditLog` (`01-data-model.md`) has `targetUserID`, `targetFacilityID`, and a free-string `action`. It has **no CCA dimension**. It is brand-new and empty with no validator, so adding a nullable field now is free — but rows written before the field exists are permanently unattributable to a CCA.

```prisma
model RoleAuditLog {
  ...
  targetFacilityID Int?
  targetCcaID      Int?     // NEW — nullable, I-2 safe (new + empty collection)
  ...
  @@index([targetCcaID, at(sort: Desc)], map: "cca_at")   // NEW
}
```

Constrain `action` to a declared vocabulary in `roles.ts` (a `const` union validated before write, not a DB enum):

```ts
export const AUDIT_ACTIONS = [
  "grant", "revoke", "set", "facilityAccess.set", "denied",   // existing
  "ccaHead.grant", "ccaHead.revoke", "ccaHead.transfer",      // reserved NOW
] as const;
```

Reserving the three strings now guarantees the future system's history is queryable alongside role history rather than living in a parallel log. `batchId` (already present) ties the two halves of a transfer into one event — no new field needed. A per-CCA leadership history is then one indexed query on `cca_at`, which is exactly what the future "history" tab renders, with no backfill.

**Denial audits must be written OUTSIDE the transaction.** `forbid()` inside `db.$transaction` rolls its own audit row back, so a denial leaves no trace — defeating abuse detection on exactly the surface most likely to be probed (a jcrc enumerating `ccaID`s). Catch at the procedure boundary and write on `ctx.db`, not `tx`:

```ts
catch (e) {
  await ctx.db.roleAuditLog.create({ data: {
    ok: false, denyReason: e.code, action: "ccaHead.transfer",
    targetCcaID, targetUserID, actorUserID, actorRoles } });
  throw e;
}
```

**This rule is general** — it applies to every G1–G7 guard that runs inside a transaction, not just to transfer. Record it in `02-backend-authz.md`.

---

## 5. C-5 — The `createBooking` `ccaID` seam, and the `ccaID: 0` hazard

`src/server/api/routers/facilitiesBooking.ts:296` takes `ccaID: z.number()` straight from the client and writes it at `:360` with no membership check; `src/app/_components/BookingModal.tsx:92` hardcodes `ccaID: 0`. Under D-1, CCA rooms become `cca_head`-gated while `ccaID` stays unvalidated — so a legitimate `cca_head` can book a CCA room and attribute it to a CCA they have nothing to do with.

**Split the fix.** The membership/headship check is behaviour-changing on a path already absorbing the resident cutover — **defer it**. The existence check is not, and there is a sharp reason to take it now:

`deleteCcaCascade` (`cascade.ts:28`) does `bookings.deleteMany({ where: { ccaID } })`. Since every booking the current UI creates carries `ccaID: 0`, **a `CCA` row with `ccaID: 0` would, on deletion, wipe every booking in the system.** `ccaID` is a plain `Int` with no reserved-value guard.

**Do now** (small, non-behaviour-changing):

1. Run the `ccaID: 0` probe in §0.3. If such a row exists, escalate — it must be re-keyed before anything else.
2. Reserve `0` as "no CCA": guard `deleteCcaCascade` with `if (ccaID === 0) throw new Error("RESERVED_CCAID");`.
3. Add an existence check in `createBooking`: `ccaID === 0 || await tx.cCA.findUnique({ where: { ccaID } })`, else reject. Without it a client can persist a booking pointing at a nonexistent CCA, and a forged `ccaID` makes an unrelated user's booking collateral damage of a future CCA deletion.

**Record for later**, in `01-data-model.md`'s CCA section: *"`createBooking.ccaID` carries no membership check. When `CcaHead` becomes authoritative, the check is `ccaID === 0 || caller heads ccaID`, applied at `facilitiesBooking.ts:360`. Not in scope now; recorded so the future check has a named home."*

### 5.1 Cascade cleanup — `CcaHead` and `UserRole` are orphaned today

Neither cascade helper touches the role collections, so deleting a CCA or a user leaves permanent, CH-1-*invisible* drift (the drift detector checks string↔row, not row↔CCA):

- Deleting a **CCA** leaves `CcaHead` rows pointing at a nonexistent `ccaID`. Those rows keep the user's `cca_head` string alive via `revokeCcaHead`'s `remaining === 0` check, and the string can never be revoked because the CCA no longer exists.
- Deleting a **user** leaves a live `UserRole` row. If that userID is later re-created (same email → same canonical userID), the new person silently inherits the deleted person's roles. **That is an escalation hole reachable with zero privilege.**

Edits to `src/server/api/services/cascade.ts`:

```diff
 export async function deleteCcaCascade(db: PrismaClient, ccaID: number) {
+  if (ccaID === 0) throw new Error("RESERVED_CCAID");   // §5
   return db.$transaction(async (tx) => {
     await tx.posts.deleteMany({ where: { ccaID } });
     await tx.userCCA.deleteMany({ where: { ccaID } });
     await tx.bookings.deleteMany({ where: { ccaID } });
+    await tx.ccaHead.deleteMany({ where: { ccaID } });
     return tx.cCA.delete({ where: { ccaID } });
   });
 }

 export async function deleteUserCascade(db: PrismaClient, userID: string) {
   return db.$transaction(async (tx) => {
     ...
+    await tx.ccaHead.deleteMany({ where: { userID } });
+    await tx.userRole.deleteMany({ where: { userID } });
+    await tx.userMatric.deleteMany({ where: { userID } });
     return tx.user.deleteMany({ where: { userID } });
   });
 }
```

> **Caveat, and it is the §0.3 problem again:** the `userID` passed to `deleteUserCascade` is A-format-vs-E-format ambiguous. `UserRole`/`UserMatric`/`CcaHead` are all keyed on the **canonical userID** (usually but not always E-format — L-27), while `tx.user.deleteMany({ where: { userID } })` matches the A-format matric. **Resolve the key format first or these three new deletes silently no-op.** Safest interim: have `deleteUserCascade` accept both keys explicitly (`{ canonicalUserID, legacyUserID }`) rather than guessing.
>
> **Sharper under the stored-`resident` revision.** The `UserRole` delete above was already required (a re-created user inheriting the deleted person's roles is the zero-privilege escalation hole named in this section). It now has a second consequence: every user holds a stored `resident`, so **every** deleted user leaves a `UserRole` row behind if this delete no-ops, and each one is an orphaned baseline row keyed on a userID with no `User` document. Those are inert — nobody can sign in as a deleted user, and the baseline confers only booking — but they are exactly what the `rbac-doctor.mjs` "resident row keyed on a non-canonical / non-existent id" line counts, so a mis-keyed cascade turns that red line into permanent noise. Per the I-16 corollary a gate that can never reach zero gets muted, which deletes the detector. Same obligation as the merge/dedupe scripts (`scripts/remediation/merge-accounts.mjs`, `dedupe-users.mjs`), which must likewise remove the *losing* account's `UserRole` row rather than orphan it.

---

## 6. Role handover / succession

### 6.1 The wording

The user wrote "predecessor"; the described flow is an **outgoing head handing the role to the person taking over**, which is the **successor**. Everything here is designed and named for succession — `transferCcaHead`, `toUserID`, "Hand over to…". Do not introduce a `predecessor` identifier anywhere; the mismatch would be a permanent readability tax. Worth one line of confirmation with the user, but the intent is not genuinely ambiguous.

### 6.2 Recommendation

> **Ship an admin/jcrc-executed atomic transfer in this phase. Defer self-serve head-initiated handover.**

The two have wildly different costs:

| | Admin/jcrc-executed `transferCcaHead` | Self-serve head-initiated handover |
|---|---|---|
| New authorization model | none — reuses G1–G7 unchanged | **yes** — per-object scope ("caller heads THIS ccaID"), a second guard system |
| New state | none | nomination / acceptance records, expiry, notification |
| Contradicts D-3? | no | **arguably yes** — D-3 just removed peer-granting for `jcrc`; adding peer-granting for `cca_head` in the same release is incoherent policy direction |
| Usable on day one? | yes | **no** — `CcaHead` is empty; there is nobody to hand over *from* |
| Risk to the lockout-critical path | none | non-trivial |

The decisive argument is the "usable" row. **On day one there are zero `CcaHead` rows** and no way to derive them (§0.1). Every initial head must be granted by an admin or jcrc regardless. Self-serve handover is a feature with no users until at least one full CCA leadership cycle has passed — comfortably after CCA management itself lands. Building it now means building an object-scoped authorization system, during the release whose top risk is ~515 users losing booking, for zero day-one users.

`transferCcaHead` is genuinely cheap: a composition of primitives `02` already specifies, it gives the user the handover affordance immediately, and it is **the exact procedure a future self-serve flow would call**, with only the guard swapped.

> **Resolving a cross-track contradiction:** the resident-rollout track recommended *not* shipping handover, on the grounds that a handover of a **flat** `cca_head` bit is not a handover but a transfer of global CCA-booking capability. That reasoning is correct **for the flat shape** — and it is exactly why C-1 stores the scope. Because `CcaHead` is written from the first grant, transfer is keyed on `(userID, ccaID)` and is well-defined: a person heading two CCAs who hands over one **keeps `cca_head`**, because `revokeCcaHead` drops the string only when their last headship goes. The objection dissolves given C-1; without C-1 it would stand.

### 6.3 The three procedures

`transferCcaHead` alone is insufficient — its `from` guard requires an existing head, so **`CcaHead` would stay empty forever.** Ship all three as siblings on `roleManagerProcedure`, in `src/server/api/routers/admin.ts`:

```ts
grantCcaHead:  roleManagerProcedure.input(z.object({
                 ccaID: z.number().int(), userID: canonicalUserIDSchema,
                 reason: z.string().max(500).optional() })).mutation(...)

revokeCcaHead: roleManagerProcedure.input(z.object({
                 ccaID: z.number().int(), userID: canonicalUserIDSchema,
                 reason: z.string().max(500).optional() })).mutation(...)

transferCcaHead: roleManagerProcedure.input(z.object({
                 ccaID: z.number().int(),
                 fromUserID: canonicalUserIDSchema,
                 toUserID:   canonicalUserIDSchema,
                 reason: z.string().max(500).optional() })).mutation(...)

listCcaHeads:  roleManagerProcedure.input(z.object({ ccaID: z.number().int().optional() })).query(...)
```

All three wrap the §2 primitives and audit with `targetCcaID` set.

### 6.4 The transfer flow

**Ordering, atomic in one `db.$transaction`: grant to the successor FIRST, then revoke from the outgoing head.** Never the reverse. A crash between the two steps must leave the CCA with *two* heads (recoverable by a second transfer), never *zero* — which, once self-serve lands, would be an unrecoverable per-CCA lockout of the same shape as the last-admin problem.

```ts
transferCcaHead: roleManagerProcedure
  .input(transferSchema)
  .mutation(async ({ ctx, input }) => {
    const { ccaID, fromUserID, toUserID } = input;
    const actor = await getActor(ctx);          // { userID, roles } — validated
    const batchId = crypto.randomUUID();

    try {
      return await ctx.db.$transaction(async (tx) => {
        // H0 NO SELF-ASSIGNMENT of a role you lack (binding v1 guard).
        //    Without this a jcrc holding no CcaHead row could transfer any
        //    CCA's headship onto themselves and become a cca_head.
        if (toUserID === actor.userID && !actor.roles.includes(CCA_HEAD_ROLE))
          forbid("NO_SELF_ASSIGNMENT");

        // H1 no-op guard.
        if (fromUserID === toUserID) forbid("TRANSFER_TO_SELF");

        // H2 CCA must exist. ccaID is client-supplied (cf. §5).
        if (!(await tx.cCA.findUnique({ where: { ccaID } }))) forbid("NO_SUCH_CCA");

        // H3 successor must have SIGNED IN at least once. Gate on UserRole,
        //    NOT UserMatric: under D-7 + the resident auto-grant a user can be
        //    fully signed in and holding resident while their matric row is
        //    still absent (the matric gate is a separate submission step), so
        //    a UserMatric gate would reject legitimate successors. This is
        //    STRONGER under the stored-resident revision, not weaker: the row
        //    is now written at account creation (I-8a) and topped up at every
        //    session read (I-8b), so "has a UserRole row" is a reliable proxy
        //    for "has signed in" rather than a materialization side effect.
        //    Do NOT tighten this to `roles.includes("resident")` — that would
        //    fail for a successor whose baseline repair has not yet landed.
        //    Deferred/pending grants (D-8) are deliberately NOT accepted here:
        //    handing a CCA to someone who may never log in is the zero-heads
        //    failure with extra steps.
        if (!(await tx.userRole.findUnique({ where: { userID: toUserID } })))
          forbid("SUCCESSOR_HAS_NOT_SIGNED_IN");

        // H4 outgoing head must actually head THIS cca.
        if (!(await tx.ccaHead.findUnique({
              where: { userID_ccaID: { userID: fromUserID, ccaID } } })))
          forbid("NOT_A_HEAD_OF_THIS_CCA");

        // H5 target guard (G3) — SHARED implementation, not hand-rolled.
        //    Hand-rolling the admin-target check is how the G1..G7 firewall
        //    stops being the single audited policy surface. Both endpoints of
        //    a transfer are targets.
        await assertMayTouchTarget(tx, actor, toUserID);
        await assertMayTouchTarget(tx, actor, fromUserID);

        // GRANT FIRST, then revoke. Order is load-bearing.
        await grantCcaHead(tx, actor,  { userID: toUserID, ccaID });
        await revokeCcaHead(tx, actor, { userID: fromUserID, ccaID });

        // H6 post-condition: assert the SUCCESSOR specifically holds the row.
        //    (A bare count >= 1 would be true by construction and assert
        //    nothing — including after an accidental reorder.)
        if (!(await tx.ccaHead.findUnique({
              where: { userID_ccaID: { userID: toUserID, ccaID } } })))
          throw new Error("INVARIANT_TRANSFER_DID_NOT_LAND");

        await writeAudit(tx, { action: "ccaHead.transfer", targetCcaID: ccaID,
          targetUserID: toUserID,   batchId, reason: input.reason, ...actor });
        await writeAudit(tx, { action: "ccaHead.revoke",   targetCcaID: ccaID,
          targetUserID: fromUserID, batchId, ...actor });
      });
    } catch (e) {
      await auditDenialOutsideTx(ctx.db, e, { action: "ccaHead.transfer",
        targetCcaID: ccaID, targetUserID: toUserID, ...actor });   // §4
      throw e;
    }
  }),
```

Answering the questions directly:

- **Approval?** Not self-serve in this phase — the caller *is* an admin or jcrc, so approval is inherent. `roleManagerProcedure` is the middleware `02` already needs; no new authorization concept.
- **Atomic grant-then-revoke?** Yes, in that order, in one transaction, with an asserted post-condition (H6). Atlas is a replica set, so `$transaction` is available — `cascade.ts:11-13` already documents and relies on this.
- **What stops handing to a random person?** H3 (must have signed in), H2 (real CCA), H5 (target guard), and an audited role-manager executor. This is weaker than a real consent flow — which is precisely the gap self-serve would close, and an argument for designing it properly rather than rushing it.
- **What stops handing to themselves?** H0 (escalation) and H1 (no-op).
- **Zero heads?** Grant-before-revoke + H6. Note `revokeCcaHead` *alone* can still zero a CCA — that is correct and intended, exactly as an admin may leave a facility with no eligible booker. The min-1 invariant applies to *transfer*, not to *revoke*.
- **Unbounded heads?** No hard cap. Soft cap in the UI: warn above 3 heads per CCA, do not block. A hard cap is a guess about org structure that will be wrong for some CCA, and unrecoverable — an admin hitting it has no in-app path around it.

### 6.5 UI surface

A **"CCAs" tab** in the single `/admin` dashboard (D-2), driven by the **server-computed capability set** — add `canManageCcaHeads: boolean` to `whoAmI()` (`02-backend-authz.md:659-661`) rather than branching on roles in the component. Row per CCA: name, current heads, and two actions — **"Add head"** (`grantCcaHead`, the day-one bootstrap path) and **"Hand over"** (`transferCcaHead`).

The user-resolution field is the **same** matric/name/NUSNET resolver D-8 requires for bulk import — build it once in `03-admin-dashboard.md`, reuse it here. Include a dry-run preview: *"E1234567 (Jane Tan) becomes head of Photography Club; E7654321 (Sam Lee) stops being head. 1 head remains."*

**No `/profile` surface.** A head cannot initiate anything in this phase, so `04-profile-page.md` needs no change beyond rendering the `cca_head` badge it already plans.

### 6.6 The upgrade path that makes self-serve cheap later

When self-serve arrives, the *only* changes are:

1. `ASSIGNABLE_BY.cca_head` becomes `["cca_head"]`.
2. A new object-scope guard `assertHeadsCca(actor, ccaID)` runs before H4.
3. The procedure moves from `roleManagerProcedure` to `protectedProcedure` + that guard.
4. A nomination/acceptance record is added so the successor consents.

Steps 1–3 are small. Step 4 is the real work, and it is the work that has no day-one user. A named, bounded upgrade path is what turns "deferred" into "designed for" rather than "postponed".

---

## 7. Verification — add to `05-verification.md`

**CH-1 drift detectors** (both must return `0`; run after every CCA mutation and in the nightly check).

> These queries are **unaffected** by the stored-`resident` revision: every one of them matches on the literal string `"cca_head"`, so the new baseline entry in `roles[]` neither satisfies nor breaks any of them in either direction. Stated only because `roles[]` now carries an extra element on every document and a reader may wonder — no edit is required. The one genuinely new query in this area, "eligible NUS users missing stored `resident`", belongs to `05-verification.md` §7 and is **not** a CH-1 detector; do not fold it in here.

```js
// string without scope
db.UserRole.aggregate([
  { $match: { roles: "cca_head" } },
  { $lookup: { from: "CcaHead", localField: "userID", foreignField: "userID", as: "h" } },
  { $match: { h: { $size: 0 } } }, { $count: "string_without_scope" } ])

// scope without string
db.CcaHead.aggregate([
  { $lookup: { from: "UserRole", localField: "userID", foreignField: "userID", as: "r" } },
  { $match: { "r.roles": { $ne: "cca_head" } } }, { $count: "scope_without_string" } ])

// orphaned scope: CcaHead pointing at a deleted CCA (§5.1)
db.CcaHead.aggregate([
  { $lookup: { from: "CCA", localField: "ccaID", foreignField: "ccaID", as: "c" } },
  { $match: { c: { $size: 0 } } }, { $count: "orphaned_ccahead" } ])

// I-1: every CcaHead key is a canonical userID (uppercased @u.nus.edu
// localpart). NOT an E-format assertion — `G.S_SAMUEL` is a real key here;
// asserting /^E\d{7}$/ is lockout mode L-27 (00-overview.md §2.4). The same
// predicate now gates the `resident` baseline WRITE (I-8d), so an E-format
// regex anywhere in this family withholds booking rather than mis-deriving it.
db.CcaHead.countDocuments({ userID: { $not: /^[A-Z0-9._%-]+$/ } })   // must be 0

// no duplicate role strings (the Prisma `push` hazard, §2)
db.UserRole.countDocuments({ $expr: { $ne: [ { $size: "$roles" },
  { $size: { $setUnion: ["$roles", []] } } ] } })                 // must be 0
```

**Test cases:**

| # | Case | Expected |
|---|---|---|
| C-1 | Grant `cca_head` to a user with **no** `UserRole` row | Row created; `roles` contains `cca_head`; legacy `role` present (`""`). The inserted row holds **no** `resident` (I-8d — this path has no verified NUS provenance). Then sign that user in: the session-callback self-heal (I-8b) `$addToSet`s `resident`, `roles` becomes `["cca_head","resident"]` in some order, and the user can book a normal room. **Asserting `resident` immediately after the grant is wrong and the test must not do it.** |
| C-2 | Grant `cca_head` for a second CCA to an existing head | `roles` contains exactly **one** `"cca_head"`; two `CcaHead` rows |
| C-3 | Revoke one of two headships | `CcaHead` count 1; `"cca_head"` **retained** |
| C-4 | Revoke the last headship | `"cca_head"` removed by `$pull`; the **stored** `resident` is still present in `roles` afterwards — assert it by re-reading the document, not by re-deriving it |
| C-5 | `setUserRoles` payload omitting `cca_head` on a head | `cca_head` **survives** (§1.3 item 3 — not expressible in `removed`); `CcaHead` untouched; the stored `resident` also survives the same write. Assert **both** strings on the re-read row |
| C-6 | Bulk import / pending grant containing `cca_head` | Rejected at validation with `USE_CCA_HEAD_ENDPOINT`; audited `ok:false` |
| C-7 | `transferCcaHead` with `from === to` | `TRANSFER_TO_SELF` |
| C-8 | jcrc (no `CcaHead` row) transfers to **themselves** | `NO_SELF_ASSIGNMENT` |
| C-9 | Successor who has never signed in | `SUCCESSOR_HAS_NOT_SIGNED_IN` |
| C-10 | `fromUserID` does not head that CCA | `NOT_A_HEAD_OF_THIS_CCA` |
| C-11 | jcrc transfers where either endpoint holds `admin` | `CANNOT_MODIFY_AN_ADMIN` |
| C-12 | Any denial above | A `RoleAuditLog` row exists with `ok:false` — **proves the denial audit survived the transaction rollback** (§4) |
| C-13 | Successful transfer | Two audit rows sharing one `batchId`; `targetCcaID` set on both; CCA has ≥ 1 head |
| C-14 | Delete a CCA that has heads | `CcaHead` rows gone; orphan detector `0`; ex-head's string dropped iff it was their last |
| C-15 | `deleteCcaCascade(0)` | Throws `RESERVED_CCAID`; **no bookings deleted** |
| C-16 | `createBooking` with a nonexistent `ccaID` | Rejected |

---

## 8. Edits this document requires to the other plan files

| File | Change |
|---|---|
| `01-data-model.md` | `CcaHead` doc comment: populated **from the first grant**, source of truth, names `access.ts::canBookWithRoles` as the single future scope-check site (§1.2). `RoleAuditLog` gains `targetCcaID Int?` + `@@index([targetCcaID, at])` (§4). Keep the "cannot be derived" section **verbatim** — it is correct — and append §0.3 as a blocking prerequisite plus the §3 `UserCCA` steps. Record the §5 `createBooking.ccaID` seam. |
| `02-backend-authz.md` | Remove `"cca_head"` from `ASSIGNABLE_BY.admin/.jcrc` and `REVOCABLE_FROM_OTHERS_BY.admin/.jcrc`; note the `ASSIGNABLE_BY.jcrc` conflict with D-3 (§1.3 item 1). Add the C-2 comment block on `cca_head: []`. Add `AUDIT_ACTIONS` incl. the three reserved strings. Export `canonicalUserIDSchema`. Add the **general** rule that denial audits are written outside the transaction (§4). Confirm `cca_head` is excluded from `GRANTABLE_ROLES` so it cannot enter `applyRoleChange`'s `removed` set — the same construction that protects the stored `resident` (I-8c); any sticky *list* left in `assertCanMutateRoles` is documentation, not mechanism (§1.3 item 3). Capability object gains `canManageCcaHeads`. **Do NOT** add a `:`/`/` check to `isGrantableRole` (§1.4). |
| `03-admin-dashboard.md` | New capability-driven "CCAs" tab with "Add head" + "Hand over"; reuses the D-8 identifier resolver (§6.5). |
| `05-verification.md` | §7 drift detectors and the sixteen test cases. |
| `06-legacy-cutover.md` | Add `src/server/api/services/ccaHead.ts` to the list of writers whose `$setOnInsert: { role: "" }` is removed when the legacy scalar drops (§2). |
| `src/server/api/services/cascade.ts` | The §5.1 diff — but only after the §0.3 key format is resolved. |

---

## Done when

**Step 0 — blocking prerequisite**
- [ ] §0.3 query run; `UserCCA` E/A/other counts, duplicate-pair count and `ccaID:0` result recorded in this file
- [ ] If `A-format > 0` or `other > 0`: §3 is **deferred** and that decision is written down
- [ ] If a `CCA` row with `ccaID: 0` exists: escalated and re-keyed before any other step

**Data shape (C-1, C-4)**
- [ ] `CcaHead` doc comment updated — source of truth, populated from first grant, names `canBookWithRoles` as the future scope-check site
- [ ] `RoleAuditLog.targetCcaID Int?` + `@@index([targetCcaID, at])` added (nullable — I-2)
- [ ] `AUDIT_ACTIONS` includes `ccaHead.grant` / `ccaHead.revoke` / `ccaHead.transfer`
- [ ] `canonicalUserIDSchema` (trim + uppercase + the shared `isResidentEligible` predicate, **no** `/^E\d{7}$/` — L-27) exported and used on every `CcaHead` write

**CH-1 made structural (§1.3)**
- [ ] `"cca_head"` removed from `ASSIGNABLE_BY.admin/.jcrc` and `REVOCABLE_FROM_OTHERS_BY.admin/.jcrc`
- [ ] `ASSIGNABLE_BY.jcrc` reconciled with D-3 (empties to `[]`); conflict noted in `02`, not lost between docs
- [ ] Generic `grant`/`revoke`/`set`/bulk/pending paths reject `cca_head` with `USE_CCA_HEAD_ENDPOINT`
- [ ] `cca_head` absent from `GRANTABLE_ROLES`, so `applyRoleChange`'s `removed` set cannot contain it — stickiness by construction at the one chokepoint, exactly as for the stored `resident` (I-8c), not a per-caller union
- [ ] `whoAmI().assignableRoles` no longer contains `cca_head`; `canManageCcaHeads` added

**Primitives (§2)**
- [ ] `src/server/api/services/ccaHead.ts` created; it is the **only** writer of `CcaHead` and of the `"cca_head"` string
- [ ] Every `UserRole` write is `$addToSet` / `$pull` via `$runCommandRaw` — no Prisma `push`, no set-payload, no read-modify-write
- [ ] Every upsert carries `$setOnInsert: { role: "" }` (D-6 window)
- [ ] Guards live **inside** the primitives; the signature requires the validated actor
- [ ] `revokeCcaHead` uses `$pull` (no P2025 on a missing row)

**UserCCA (§3)**
- [ ] Duplicate census run; `mongodump` taken if a dedupe is needed; backups dir confirmed gitignored
- [ ] `dedupe-usercca.mjs` dry-run reviewed, then applied
- [ ] `@@unique([ccaID, userID])` + `@@index([ccaID])` added to the schema and landing in the **single** scheduled `db push` — not a standalone push

**Booking / cascade seams (§5, §5.1)**
- [ ] `deleteCcaCascade` throws on `ccaID === 0`
- [ ] `createBooking` rejects a nonexistent non-zero `ccaID`
- [ ] `deleteCcaCascade` deletes `CcaHead`; `deleteUserCascade` deletes `CcaHead` + `UserRole` + `UserMatric`
- [ ] The `deleteUserCascade` key-format ambiguity is resolved (or the helper takes both keys explicitly)

**Handover (§6)**
- [ ] `admin.grantCcaHead`, `admin.revokeCcaHead`, `admin.transferCcaHead`, `admin.listCcaHeads` shipped on `roleManagerProcedure`
- [ ] Transfer is one `$transaction`, grant-before-revoke, with the H6 successor-specific post-condition
- [ ] H0 (no self-assignment), H1–H5 all present; H5 calls the **shared** target guard
- [ ] Denial audits written on `ctx.db` outside the transaction and verified to survive rollback
- [ ] `/admin` CCAs tab with "Add head" + "Hand over", dry-run preview, soft warning above 3 heads
- [ ] The §6.6 four-step self-serve upgrade path recorded in `02`'s `cca_head: []` comment

**Verification (§7)**
- [ ] All five drift/integrity queries return `0`
- [ ] All sixteen test cases pass, C-5 (sticky) and C-12 (denial audit survives rollback) explicitly among them
