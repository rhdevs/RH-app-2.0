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

## Step 0 — Create new collections + indexes (NEVER with `prisma db push`)

The code already added safe new collections to `schema.prisma`
(`RateLimit`, `Counter`, `BookingLock`, `UserRole`, `FacilityAccess`, and
`PasswordResetSession.used`). Their **unique indexes** need to exist before
anything that depends on them is safe to run — the booking lock and counter
are only safe once `BookingLock.key` / `Counter.key` are unique.

This step used to say to run `npx prisma db push` here. That instruction is
retracted, not annotated: `prisma db push` silently drops
`User.email_unique_ci`, the case-insensitive unique index on `email` that is
the duplicate-account guard. Prisma cannot represent a collation index in
`schema.prisma`, so every `db push` sees it as not-in-schema and removes it —
with no warning and without `--accept-data-loss`. Do not run it against this
cluster, here or anywhere else in this file.

Indexes on this cluster are created with `createIndexes` through
`$runCommandRaw`, never through `db push`. There are exactly two scripts that
do it, and between them they are how every index added since phase 2 got here:

- **`create-auth-allowlist.mjs`** — the working precedent. It created the
  `AuthAllowlist` collection and its two unique indexes this way, and they
  exist today by that route and no other.
- **`create-event-phase2-indexes.mjs`** — the events questions/attendance
  indexes. It takes an **explicit target on the command line and has no
  default**: `EventQuestion` (Part B) or `EventAttendance` (Part C). Named with
  neither, it prints usage and exits 2 rather than guessing or doing both.

```bash
node scripts/remediation/index-census.mjs > census-before.txt          # blocking, exit 0 required
node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion            # dry run
node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion --commit   # apply
node scripts/remediation/index-census.mjs > census-after.txt
diff census-before.txt census-after.txt                               # ONLY the EventQuestion lines
```

Take an `index-census.mjs` on **both sides** of any index work and diff the
two. Any **removed** line is a dropped index and the cluster must take no
further writes until it is restored; `User.email_unique_ci` in particular must
still be there afterwards. The database step for a Mongo field-only schema
change is `npx prisma generate` and nothing else — it reads the schema file and
never touches the cluster.

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

1. ~~**`npx prisma db push`** — creates the `UserMatric` collection + its
   `userID` unique index and regenerates the client.~~
   **HISTORICAL — DO NOT RUN.** This migration already ran; `UserMatric` and its
   index exist. The instruction is left visible rather than deleted so the record
   of what was actually done stays honest, but `db push` is retracted repo-wide
   (see Step 0): it silently drops indexes absent from `schema.prisma`, and it
   has cost this database `email_unique_ci` once. Were this run again today, the
   collection and index would be created with `$runCommandRaw` and the client
   regenerated with `npx prisma generate`.
2. **Deploy the login-gate code first** (auth session lookup, `matricProcedure`,
   `MatricGate`, `/onboarding/matric`, `user.setMatric`) so freshly-merged users
   who have no matric can actually clear the gate.
3. Capture pre-migration global per-collection counts for Bookings/Posts/Order/
   UserCCA/Gym as an independent baseline (see the risk register R17).

### Run order

```bash
# HISTORICAL run order — this migration has already been applied.
# The first line WAS `npx prisma db push`. Retracted: see the prerequisites
# above and Step 0. Do not run it; UserMatric and its index already exist.
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

## Step: merge by CANONICAL id (#16) — `merge-by-canonical.mjs`

The successor to `merge-accounts.mjs` for the residual duplicate class. Read that
script first — this one follows its idiom (grouping, `byRecent`, `reassignRaw`,
backup-before-write, `inspectWriteReply`, abort-on-empty-target) and differs in
three ways only.

**1. It groups by `canonicalUserID(email)`, not by the lowercased email string.**
A lowercased-string key folds case but not whitespace, which is why
`"e0425010@u.nus.edu "` has survived every previous dedupe pass. The canonical id
is the value the session callback derives, so every address a session would
resolve to one identity lands in one group.

**2. Per-field conflict detection.** Each mergeable field is classified across
the group:

| field | compared as | absent when | on conflict |
|---|---|---|---|
| `displayName` | trim + collapse whitespace + case-insensitive | blank | clear `""`, flag `displayName` |
| `bio` | trim only (case/interior text are content) | blank | clear `""`, flag `bio` |
| `telegramHandle` | trim + strip leading `@` + lowercase | blank | clear `""`, flag `telegramHandle` |
| `block` | exact int | `null` | clear `null`, flag `block` |
| `modules` | set-equality, order-insensitive | `[]` | clear `[]`, flag `modules` |
| `userCCA` | set-equality, order-insensitive | `[]` | clear `[]`, flag `modules` |
| `imageKey` | verbatim after trim | blank | clear `""`, flag `profilePicture` |

Absent-vs-present is **not** a conflict: the present value wins and nothing is
flagged. That distinction is what keeps `modules` (`[]` vs `["HY2262","PR2202"]`)
out of the flag list.

**Never cleared:** `userID` is the ownership key every dependent row is keyed on
— it is forced to the canonical id. `passwordHash` is never cleared either;
clearing it would lock the user out of the account they must log into to answer
the prompt. `email` is normalized. `createdAt` takes the earliest value.

**3. The matric.** `userID` holding two different A-format matrics is the case
that matters. The matric lives in `UserMatric`, not on `User`, so the resolution
is: write **no** `UserMatric` row, delete any existing one for that canonical id,
and flag `matric`. The login gate then prompts and `setMatric` validates the
format. Picking one of two values a check digit apart would silently assign a
real person the wrong student number.

Conflicts are recorded in the new **`ProfileCompletion`** collection, keyed by the
canonical userID:

```prisma
model ProfileCompletion {
  id          String    @id @default(auto()) @map("_id") @db.ObjectId
  userID      String    @unique       // CANONICAL id (I-1)
  needsFields String[]  @default([])  // e.g. ["matric","telegramHandle"]
  reason      String?
  flaggedAt   DateTime?
  resolvedAt  DateTime?
}
```

A separate collection for the same reason as `UserRole` / `UserMatric`: the
`User` collection's DB-level `$jsonSchema` has no such property and would reject
the write. The migration never writes `resolvedAt`, so a re-run cannot un-resolve
a prompt the user already answered.

**Survivor selection** (deterministic, total): `userID` already canonical → has a
`passwordHash` → most complete (most non-absent mergeable fields) → most recently
created → lowest `_id`. Completeness sits above recency because the live
duplicate pair was created minutes apart, so "most recent" is a coin flip; field
count is a real signal about which account was lived in. The choice cannot change
any merged field value — conflict detection runs over the whole group — it only
decides which `_id`, and therefore which `Session`/`Account`/`Authenticator` rows,
survives.

### Run order

```bash
# HISTORICAL run order — already applied; ProfileCompletion and its unique
# index exist. The first line WAS `npx prisma db push`. Retracted (see Step 0):
# a push drops indexes absent from schema.prisma and has cost this database
# email_unique_ci once. Create collections/indexes with $runCommandRaw instead.
node scripts/remediation/merge-by-canonical.mjs             # DRY RUN — review the full change set
# ...review: per-group AGREE/ABSENT/CONFLICT per field, the matric decision,
#    reassignment counts, the ProfileCompletion flags, and the email
#    normalization list...
node scripts/remediation/merge-by-canonical.mjs --commit    # apply
```

`APPLY=yes` is accepted as a synonym for `--commit` (`isCommit()` in `lib/rbac.mjs`).
Deploy the ProfileCompletion prompt UI **before** committing, so flagged users can
clear it. A JSON backup of every affected `User`, `UserRole`, `UserMatric` and
`ProfileCompletion` document plus all dependent-row counts is written to
`backups/merge-by-canonical-<stamp>.json` before the first write; the run aborts
if it cannot be written.

Apply ordering per group is crash-safe: dependents reassigned → `UserRole` merged
by value → `UserMatric` resolved → `ProfileCompletion` flag written → survivor
`$set` → losers deleted **last**. A crash therefore leaves an over-flagged
account, never a merged-but-unflagged one. `UserRole`/`UserMatric` are merged by
value rather than by `updateMany` because their `userID` is uniquely indexed — a
blind move would be a duplicate-key `writeError`, which `$runCommandRaw` reports
in the reply rather than throwing.

### Preventing recurrence

Three layers, weakest to strongest.

1. **Normalize at every write path.** `api/register/route.ts` already applies
   `normalizeEmail()`. The OAuth path did not: `PrismaAdapter.createUser` writes
   `profile.email` verbatim, so a `profile()` override was added to the Google
   provider in `src/server/auth.ts` to route it through the same normalizer.
   Step 6g of the migration normalizes every stored address, including the
   trailing-space singleton.
2. **`email_unique_ci`** — unique index on `User.email`, collation strength 2.
   Catches case-only duplicates. Sufficient only *because* layer 1 guarantees
   stored addresses carry no whitespace; a collation folds case and nothing else.
3. **`userID_unique`** — unique partial index on `User.userID` (string-typed
   values only). This is the one that actually catches the class, because
   `userID` is derived from the email: two rows meaning one human collide on it
   however their raw addresses are spelled. It is created **conditionally**: the
   script first checks for existing shared `userID` values and skips the index,
   naming every offender, if any exist. That check must stay — ~515 legacy
   singletons still carry an A-format matric in `userID` (finding #9, deliberately
   not rewritten), and forcing an index that cannot build would be an outage.

**What this does not catch:** a person with two genuinely different `@u.nus.edu`
addresses; unicode-homograph domains (the anchored ASCII regex rejects them
outright, so such a row has no canonical id and is reported as `UNCANONICAL`
rather than merged); plus-addressed variants (also rejected, same outcome); and
writes made outside this app — the droplet Python backends and any `mongosh`
session. For those, layers 2 and 3 are the only defence, and layer 3 only holds
once it has actually been created. Rows with no canonical id are listed by
`_id` and email in the dry run and are never merged or re-keyed.

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

Validate any such change against the DB `$jsonSchema` validators first — several
of these collections have one, and a Prisma-side field that the validator
rejects breaks writes at runtime, not at build time.

> [!CAUTION]
> This line used to end "…before `prisma db push`". **Retracted, per Step 0:** a
> push drops every index absent from `schema.prisma`, including
> `User.email_unique_ci`, which it has already destroyed once. Editing
> `schema.prisma` for a MongoDB scalar or a Prisma-level relation needs
> `npx prisma generate` and nothing more — Mongo has no column to add. If a
> change genuinely needs a new INDEX, create it with `createIndexes` through
> `$runCommandRaw`, the way `create-auth-allowlist.mjs` does.

## Step: sweep blank event drafts (maintenance, on demand) — `sweep-blank-event-drafts.mjs`

Nobody runs this automatically; run it when the events list gets noisy. It is
a dry-run-by-default remediation script (`--commit` to act) that deletes an
`Event` row only when it is a `draft` with nothing typed in it, no gallery, no
room booking, no signups, no child rows, and no audit row naming it, and it is
older than 30 days. It is the only place an `Event` row is ever deleted, and
it is not reachable from the application. It does not touch `Counter`.

Like the other standalone scripts in this repo, it needs the environment
loaded first — Prisma no longer auto-loads `.env`:

```bash
set -a && . ./.env >/dev/null 2>&1 && set +a && node scripts/remediation/sweep-blank-event-drafts.mjs             # preview
set -a && . ./.env >/dev/null 2>&1 && set +a && node scripts/remediation/sweep-blank-event-drafts.mjs --commit    # apply
```

## Step: events phase-2 indexes (rollout, once per target) — `create-event-phase2-indexes.mjs`

**Who runs it and when:** the person doing the events rollout, once per PR, at
the step the plan names — `EventQuestion` during **PR 2 (Part B)**,
`EventAttendance` during **PR 3 (Part C)**. Never on a schedule, and never both
in one run: the target is an explicit argument with no default, and PR 2's
census diff is supposed to show only the `EventQuestion` lines.

It creates the collection (`create`, so a re-run says `NamespaceExists` rather
than nothing) and its compound unique index, then **re-reads `listIndexes` and
proves the result**, matching on the key pattern rather than the index name. It
is idempotent — `48/68/85/86` are reported as "already present", not failures —
and `E11000` is never swallowed, because it means existing rows already violate
the uniqueness and **nothing was built**. Dry run by default. See Step 0 above
for the census-on-both-sides procedure, which is not optional.

```bash
set -a && . ./.env >/dev/null 2>&1 && set +a && node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion            # preview
set -a && . ./.env >/dev/null 2>&1 && set +a && node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion --commit   # apply
```

Afterwards, `node scripts/remediation/verify-events-schema.mjs` check `[8]`
proves the index is there and enforcing. Part B has no feature flag, so that
check is the only gate on it.

## Step: purge event answers (retention, on demand) — `purge-event-answers.mjs`

**Who runs it and when: nobody automatically. A human, whenever they choose.
There is no cron in this repository** — no `vercel.json`, no cron key in
`package.json` or `next.config.js`. Do not read a schedule into this section
that does not exist.

**What makes that acceptable:** the application's read cutoff is unconditional
and needs no operator. `getAttendees`, `exportAttendees` and `getSignupAnswers`
return **no answers at all** once 60 days have passed since
`(endTime ?? startTime)` — whether or not the rows still hold them, and whether
or not `Event.answersPurgedAt` is set. The answers stop being *reachable* on
time regardless. What this script buys is that they stop *existing*.

For each `Event` with `answersPurgedAt` unset whose `(endTime ?? startTime)` is
more than 60 days past, it empties the `answers` list on that event's
`EventSignup` rows and **then** stamps `answersPurgedAt` — in that order, so an
event can never claim a purge it did not get. **Signup rows are never deleted**,
which is what keeps the signup and attendance counts (and the Part D
dashboards) working on a purged event. Events with no date on file are skipped
and reported separately. It writes no `RoleAuditLog` row — it has no actor — so
its record is `Event.answersPurgedAt` plus its own stdout: **redirect that to a
file.** Run `npx prisma generate` first; `EventSignup.answers` is not in a
stale client.

```bash
set -a && . ./.env >/dev/null 2>&1 && set +a && node scripts/remediation/purge-event-answers.mjs                                  # preview
set -a && . ./.env >/dev/null 2>&1 && set +a && node scripts/remediation/purge-event-answers.mjs --commit > purge-$(date +%F).txt # erase
```

`verify-events-schema.mjs` `[11]` prints how overdue the purge is, and `[10]`
fails if any event claims a purge its signups did not get.

---

### Order of operations summary

1. new collections/indexes — `create-auth-allowlist.mjs` /
   `create-event-phase2-indexes.mjs` (**never** `npx prisma db push`; see Step 0)
2. `node scripts/remediation/seed-rbac.mjs`
3. emailLower backfill → schema `@unique` → generate
4. money backfill (preview → apply) → schema `Int` → generate
5. BookingLogs backfill (preview → apply) → schema types → generate
6. (optional) Food-domain relations → generate

Also update `.env` / `.env.example`: remove `DISCORD_*`, ensure `RESEND_API_KEY`
is set, and optionally set `APP_URL` and `BCRYPT_ROUNDS`. Replace the placeholder
`NEXTAUTH_SECRET="secretstring"` with `openssl rand -base64 32`.
