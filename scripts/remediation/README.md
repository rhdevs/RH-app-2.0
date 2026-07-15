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
should be done as a deliberate, reviewed migration.

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
