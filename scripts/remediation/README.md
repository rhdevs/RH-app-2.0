# Remediation migrations

These steps finish the audit fixes that touch **existing data** or the
**validator-guarded** collections (`User`, `Facilities`, `FoodMenu`, `FoodOrder`,
`Order`, `SupperGroup`, `BookingLogs`). The application code for everything else
is already merged; this is the part that must run against your MongoDB.

Back up the database before running anything destructive.

```bash
# one-time: the money/log scripts use the raw driver
npm i -D mongodb
```

---

## Step 0 — Create the new collections + indexes (REQUIRED)

The code already added safe new collections to `schema.prisma`
(`RateLimit`, `Counter`, `BookingLock`, `UserRole`, `FacilityAccess`, and
`PasswordResetSession.used`). Push them so their **unique indexes** exist — the
booking lock and counter are only safe once `BookingLock.key` / `Counter.key`
are unique:

```bash
npx prisma db push
```

## Step 1 — Seed RBAC so "SCRC Room" stays restricted (#23)

The hardcoded `jcrcList` was removed from the client; this reproduces it
server-side. Also seeds the bookingID counter.

```bash
node scripts/remediation/seed-rbac.mjs
```

## Step 2 — Merge duplicate-email accounts, then enforce uniqueness (#16)

⚠️ **This is a MERGE, not a delete.** A dry-run revealed that 58 of 59
duplicate-email groups have accounts under TWO different identity schemes for the
same person — `A0xxxxxxX` (matric number) and `E0/E1xxxxxx` (NUSNET id derived
from the email) — and their data is SPLIT across both userIDs (~396 bookings +
146 gym records + CCA/orders on the accounts a naive de-dup would delete). So the
data must be reassigned before any account is removed.

```bash
node scripts/remediation/dedupe-users.mjs   # preview only; the destructive path
                                            # is guarded and refuses mixed-userID
                                            # groups (FORCE_UNSAFE_DELETE=yes to override)
```

Proper resolution (pending a decision on the canonical userID scheme — the live
app derives `session.user.userID` from the email, i.e. the E-NUSNET form):
1. For each pair, pick the canonical userID.
2. Reassign `Bookings`, `Gym`, `UserCCA`, `Posts`, `Order` from the other userID
   to the canonical one.
3. Delete the redundant `User` document.
4. Create a case-insensitive unique index on `User.email` (collation strength 2).

This is entangled with the deeper userID inconsistency (audit finding #9) and
should be done as a deliberate, reviewed migration — implemented as
`merge-accounts.mjs` below.

## Step: merge accounts (#16) — `merge-accounts.mjs`

The real, non-destructive resolution of Step 2. It MERGES every same-email group
into ONE canonical account, **reassigns all dependent data before deleting
anything** (so the ~396 bookings / 146 gym / CCA / order / post rows on the
"extra" accounts are never orphaned), records each user's matric as an ATTRIBUTE
in the new `UserMatric` collection (the SAME storage the login gate reads), and
finally enforces case-insensitive email uniqueness. It supersedes
`dedupe-users.mjs` for the 58 mixed-userID groups that script refuses to touch.

Canonical identity per email group is derived by `canonicalUserID()` from
`scripts/remediation/lib/identity.mjs` — the one shared derivation, mirrored by
`src/lib/identity.ts` and gated by `verify-identity-parity.mjs`. **This runbook
deliberately states no formula:** an earlier revision of this line restated the
pre-`9cb701b` unanchored `.replace()` and kept restating it for months after the
code changed, which is how a reviewer re-derives a wrong invariant from the docs.
Read the module. The surviving `User.userID` is forced to that value so it
matches `session.user.userID` at runtime.

An address that is not `@u.nus.edu` canonicalises to `""`. Such a group is
**refused**, twice over (`EMPTY_CANONICAL` and `NON_NUS_EMAIL`), and if one ever
reaches the apply loop un-refused the entire run aborts without writing —
there is no key the script could write for it that a session would ever produce.

**Write flag:** this script uses `APPLY=yes` (NOT `DRY_RUN=false`) — default is
dry-run. **Backup:** every affected `User` doc is written to
`scripts/remediation/backups/merge-backup.json` before any delete (the run aborts
if that write fails). **Idempotent:** safe to re-run — merged groups collapse to
singletons, reassignments match 0 rows, the keeper is already canonical, matric
upserts are stable, and index creation is a no-op if present.

### Prerequisites (in order)

1. **`npx prisma db push`** — creates the `UserMatric` collection + its `userID`
   unique index and regenerates the client. `src/server/auth.ts` already reads
   `db.userMatric`, so this is required before the app (and the gate) run.
   (The migration itself writes `UserMatric` via `$runCommandRaw`, so it does not
   depend on the regenerated delegate — but the app does.)
2. **Deploy the login-gate code first** (auth session lookup, `matricProcedure`,
   `MatricGate`, `/onboarding/matric`, `user.setMatric`) so freshly-merged users
   who have no matric can actually clear the gate.
3. Capture pre-migration global per-collection counts for Bookings/Posts/Order/
   UserCCA/Gym as an independent baseline (see the risk register R17).

### Run order

```bash
npx prisma db push                                  # create UserMatric (prereq)
node scripts/remediation/merge-accounts.mjs         # DRY RUN — review output
# ...review: 58 mixed groups expected; check flags, matric picks, deletes,
#    before/after conservation lines, and the IDENTITY_MISMATCH_FOLLOWUP list...
APPLY=yes node scripts/remediation/merge-accounts.mjs   # apply (writes)
```

Dry-run prints, per group: canonical userID, chosen matric, keeper `_id` (and any
`userID -> canonical` rename), the source userIDs whose data moves, delete count,
before-counts per dependent collection, and any flags (`NO_HASH_IN_GROUP`,
`NON_NUS_EMAIL`, `MULTIPLE_MATRICS`, `CANONICAL_COLLISION_OUTSIDE_GROUP`, etc.).
Groups flagged `NO_HASH_IN_GROUP` / `EMPTY_CANONICAL` /
`CANONICAL_COLLISION_OUTSIDE_GROUP` are **skipped** for manual handling and block
index creation. Apply mode recounts after the merge and asserts, per collection:
`after[canonical] == Σ before[oldIDs]`, `after[source] == 0`, and global
conservation — printing `*** VERIFY FAILED ***` and exiting non-zero on any miss.
The `email_unique_ci` index is created only when there are **zero** failures.

### Finding #9 — the 515 non-duplicate matric-only users (documented follow-up)

These have a UNIQUE email, so they are **singletons** and are NOT merged. But
their `userID` is their A-format matric, while their runtime
`session.user.userID` is the E-format value derived from their email — so their
Bookings/etc. are **mis-keyed** and look empty at runtime. This migration:

- **Pre-seeds** `UserMatric{ userID: <their A-format userID>, matric: <same> }`
  (create-only, never clobbers) so the login gate does **not** needlessly prompt
  them. It does **NOT** rewrite their `userID`.
- **Reports** every such singleton as `IDENTITY_MISMATCH_FOLLOWUP` with a sample,
  recommending a **separate, backed-up, signed-off re-key migration** that
  reassigns their dependent data from the A-format userID to their canonical
  NUSNET id. That changes 515 users' data keys and must be run deliberately.

The 713 NUSNET-only users have no A-format account anywhere, so they get no
`UserMatric` row and the gate correctly prompts each of them once — intended.

`BookingLogs` (audit history) is **counted per userID but not reassigned** — an
explicit out-of-scope follow-up printed under `AUDIT-ONLY`.

## Step 3 — Money as integer cents (#18)

Preview first, then apply. **Confirm the dollars→cents assumption** in the
script header against your data.

```bash
node scripts/remediation/backfill-money-cents.mjs                 # preview
DRY_RUN=false node scripts/remediation/backfill-money-cents.mjs   # apply
```

Then change these `Json`/`Float` fields to `Int` in `schema.prisma` and
`npx prisma generate`:

- `FoodMenu.price`, `FoodMenuCustomOptions.price`
- `FoodOrder.foodPrice`, `FoodOrder.price`, `FoodOrderCustomOptions.price`
- `FoodOrderData.foodPrice`, `FoodOrderData.price`, `FoodOrderDataCustomOptions.price`
- `Order.totalCost`
- `SupperGroup.currentFoodCost`, `SupperGroup.totalPrice`

## Step 4 — BookingLogs strict types (#19)

```bash
node scripts/remediation/backfill-bookinglogs.mjs                 # preview
DRY_RUN=false node scripts/remediation/backfill-bookinglogs.mjs   # apply
```

Then in `schema.prisma` change `BookingLogs`:

```prisma
bookingID Int?      // was Json?
bookUntil Int?      // was Json?
forceBook Boolean?  // was Json?
// delete the now-redundant `forceBooking Boolean?` field
```

## Step 5 — Cascade deletes for the Food domain (#17)

The Int-keyed cascade is provided as code in
`src/server/api/services/cascade.ts` — route any future parent-delete endpoints
through it. For the ObjectId-keyed Food domain you can additionally add native
relations with enforced cascade, e.g.:

```prisma
model Restaurants {
  // ...
  foodMenus  FoodMenu[]
  foodOrders FoodOrder[]
}

model FoodMenu {
  // ...
  restaurant Restaurants @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  foodOrders FoodOrder[]
}

model FoodOrder {
  // ...
  restaurant Restaurants @relation(fields: [restaurantId], references: [id])
  foodMenu   FoodMenu    @relation(fields: [foodMenuId], references: [id])
}
```

Validate against the DB `$jsonSchema` validators before `prisma db push`.

---

### Order of operations summary

1. `npx prisma db push` (new collections/indexes)
2. `node scripts/remediation/seed-rbac.mjs`
3. emailLower backfill → schema `@unique` → generate
4. money backfill (preview → apply) → schema `Int` → generate
5. BookingLogs backfill (preview → apply) → schema types → generate
6. (optional) Food-domain relations → generate

Also update `.env` / `.env.example`: remove `DISCORD_*`, ensure `RESEND_API_KEY`
is set, and optionally set `APP_URL` and `BCRYPT_ROUNDS`. Replace the placeholder
`NEXTAUTH_SECRET="secretstring"` with `openssl rand -base64 32`.
