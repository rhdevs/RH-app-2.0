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

## Step 2 — emailLower unique (#16)

```bash
node scripts/remediation/backfill-emailLower.mjs
```

Then add to the `User` model and `npx prisma generate`:

```prisma
emailLower String? @unique
```

> If the `User` collection has a strict `$jsonSchema` validator, add `emailLower`
> to it first (Compass → collection → Validation), or the `$set` write is rejected.
> Update `register` and the auth lookups to write/read `emailLower` for full
> case-insensitive uniqueness.

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
