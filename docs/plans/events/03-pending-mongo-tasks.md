# Pending database + ops tasks — Events Part C

**Status: NOT YET RUN.** Everything here needs a network where **TCP 27017 is not
firewalled outbound**. Part C was designed and implemented without database
access, so nothing below has been executed and no figure in it is measured.

This file exists because the work and the ability to run it were separated in
time. Delete it once every task is done and its result is recorded here.

**T1–T9.** T1–T6 were written with Part C's first draft; **T7, T8 and T9 were added
on 2026-08-27 during the reconciliation pass against shipped Parts A and B.** The
new three are not optional extras — T7 and T9 each guard a crash-or-lockout on the
authorisation path, and T8 is the ordering that makes T1/T3 mean anything.

**Re-confirmed 2026-08-27: the database is still unreachable from here.** The
Atlas SRV record resolves (`cluster0-shard-00-00.0urzo.mongodb.net:27017` and two
siblings) but every TCP connection to it **times out**, which is an egress
firewall rather than an Atlas IP-allowlist problem. Nothing in this file has been
run, and **no production figure anywhere in plan 02 or this file is measured.**

**How to know you have access:**

```bash
timeout 8 bash -c 'cat < /dev/null > /dev/tcp/portquiz.net/27017' && echo OPEN || echo BLOCKED
```

`OPEN` means proceed. `BLOCKED` means the egress firewall is in the way — a phone
hotspot is enough; adding an IP to Atlas is not, because it is not an allowlist
problem.

**Loading env for standalone scripts** — Prisma no longer auto-loads `.env` here:

```bash
set -a && . ./.env >/dev/null 2>&1 && set +a
```

---

## Standing rules — do not break these to get a task done

1. **NEVER `prisma db push`, `prisma migrate dev`, or `prisma migrate deploy`.**
   `npx prisma generate` only. A push silently drops `User.email_unique_ci`, the
   case-insensitive duplicate-account guard Prisma cannot represent in
   `schema.prisma`. It has cost this database that index once already.
2. **Never use the `db:*` npm scripts** — they were removed for this reason
   (`db:generate` ran `prisma migrate dev`). Call `npx prisma generate` directly.
3. **A Prisma `@unique` creates NOTHING on MongoDB.** Every index is created
   explicitly with `createIndexes` through `$runCommandRaw`.
4. **`eventID 1` is a REAL user event** — "Test event", published, `ccaID 50`,
   with a real facility booking and one real signup. Never modify or delete it.
   It also holds the **TV Room from 23–29 Sept 2026 (6.13 days)**; cancelling
   that event is the only thing that releases the booking, and that is the
   user's call, not a task here.
5. Every write below is **dry-run first**, and `--commit` only after reading the
   dry run.

---

## T1 — Create the `EventAttendance` unique index (BLOCKING for Part C)

Without it, `P2002` cannot fire and the "a re-scan is idempotent" guarantee is
not a guarantee at all — the same door scan can write two attendance rows.

```bash
node scripts/remediation/index-census.mjs > census-BEFORE-partC.txt
node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance            # dry run
node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance --commit
node scripts/remediation/index-census.mjs > census-AFTER-partC.txt
diff census-BEFORE-partC.txt census-AFTER-partC.txt
```

**The only acceptable delta** is `EventAttendance`'s `_id_` and
`event_attendee`, plus the index count rising by one or two.
**`User.email_unique_ci` MUST still be present** in the AFTER census.

Then prove it *enforces* rather than merely exists — an index that exists but
does not enforce is worse than none. Insert twice against a non-existent
`eventID` (e.g. `999999`, so real data cannot be touched) and confirm the second
is refused with `P2002`, then delete the probe row.

- [ ] Run. Result:

## T2 — Verify the schema

```bash
node scripts/remediation/verify-events-schema.mjs
```

Check `[9]` (`EventAttendance.event_attendee`) is **informational while the
collection is absent and blocking once it exists** — after T1 it must be OK, not
INFO. Expect **PASS, exit 0**, with no `--pre-rollout` flag.

- [ ] Run. Result:

## T3 — `EVENT_QR_SECRET` (Vercel, not Mongo)

Part C's rotating check-in token is an HMAC keyed by `EVENT_QR_SECRET`. It is
**declared `.optional()` in `src/env.js` and required in fact** — the same shape
as `BLOB_READ_WRITE_TOKEN` (`env.js:36-45`), so a contributor who has not pulled
it can still build the app, while the attendance feature alone fails closed with
`ATTENDANCE_NOT_CONFIGURED`. Declaring it required would stop the whole app
building for everyone.

**Two edits in `src/env.js`, and the second is the one that gets missed:** the
`server:` block *and* the `runtimeEnv:` block (`env.js:71` is where
`BLOB_READ_WRITE_TOKEN` does it). Miss `runtimeEnv` and it reads `undefined`
forever, with no error. Also add a commented empty placeholder to
`.env.example` — that file is committed, so it carries no value.

- Generate: `openssl rand -base64 48`
- Set in **Vercel Production** (and Preview if the door page is to be tested
  there), then redeploy — env changes do not apply to existing deployments.
- Never commit it. Never log it. It must not reach the browser: the token is
  minted server-side and only the signed result is sent.
- Rotating it invalidates every outstanding token immediately, which is the
  correct behaviour if it is ever suspected of leaking.

- [ ] Set. Confirmed present in Production:

## T4 — Ship the door layer dark

Part C is gated behind `events.attendance.enabled` so it can be switched on for
one trial event rather than for the whole hall at once. Absent row = OFF.

Leave it **OFF** at merge. Turn it on only for the trial in T6.

- [ ] Confirmed absent/off at merge:

## T5 — Pre-flight measurements

Record actual numbers rather than carrying any forward:

```
Event / EventSignup / EventQuestion / EventAttendance / EventLock counts
event.* audit row count
Bookings total, and the count with ccaID: 0
```

Note whether anyone has used the events feature yet — as of 2026-08-27 the only
event was the user's own `Test event`, so the first real head-created event is a
meaningful milestone and its behaviour is worth watching.

- [ ] Run. Result:

## T6 — The trial event

The door layer must meet a real door once before it meets a big one. Pick
something small and friendly — a CCA social rather than a hall dinner — with the
paper fallback roster in hand and someone able to call it off.

What cannot be verified any other way:

- A rotating token actually scans, including across a 30-second rotation
  boundary (the previous-window grace path).
- The camera opens at all on the committee's real phones. **iOS Safari needs an
  explicit user gesture, and in-app browsers — a link opened inside Telegram or
  Instagram — frequently refuse camera access outright.** The door page must say
  "open this in Safari or Chrome" rather than showing a black rectangle.
- A walk-in with no signup is recorded, and shows as a walk-in afterwards.
- The manual fallback finds someone by name and by matric.
- A double scan of the same person is idempotent (this is what T1 protects).

- [ ] Done. Event used, and what broke:

---

## T7 — Prove `scannerUserIDs` reads as `[]` and never `undefined` (BLOCKING before the flag)

**What this protects against:** a crash at a door, on the authorisation path, for the person
holding the phone.

Two lines of Part C dereference this column without a guard:

- `assertMayScan` — `event.scannerUserIDs.includes(userID)` (D-61)
- the `create` reuse branch — `existing.scannerUserIDs.length === 0` (D-59a)

Both throw `TypeError: Cannot read properties of undefined` if the key is absent on the row.
`create` has written `scannerUserIDs: []` explicitly since Phase 1 (`event.ts:713`), and so does
`duplicate` (`event.ts:1259`) — **but no row has ever been read back through Prisma for this
field, because nothing reads it yet.** Prisma returns `[]` for an absent *scalar* list in
principle; this database has not been asked. That is T-24's shape, and §13.2 step 2 already
treats the composite-list version of the same question as blocking.

```js
// Read-only. Count rows MISSING the key entirely, and rows where it is null.
db.Event.countDocuments({ scannerUserIDs: { $exists: false } })
db.Event.countDocuments({ scannerUserIDs: null })
db.Event.countDocuments({})
```

**Acceptable result: both of the first two are `0`.** Then read one real row back *through
Prisma* (not the shell) and confirm the value is `[]` and that `.length` and `.includes()` work:

```bash
set -a && . ./.env >/dev/null 2>&1 && set +a
node -e '
const {PrismaClient}=require("@prisma/client");const db=new PrismaClient();
db.event.findFirst({select:{eventID:true,scannerUserIDs:true,attendanceOpensAt:true}})
 .then(r=>console.log(JSON.stringify(r), "isArray:", Array.isArray(r?.scannerUserIDs)))
 .finally(()=>db.$disconnect());'
```

**If any row is missing the key**, do **not** backfill blindly and do **not** `db push`. Add a
`?? []` guard at both dereference sites and record it here — a guard is cheap, a backfill on a
collection with a live event in it is not.

- [ ] Run. Missing-key count: ___ · null count: ___ · Prisma returned: ___

## T8 — The switch-on sequence, in this order, and the order is the control

Each step exists to make the next one safe. **Running them out of order can leave the flag on
while the door cannot work, which is the one state with no good failure message.**

1. **T1 and T2 pass.** The index exists *and* enforces. Without this a double scan silently
   double-counts.
2. **`EVENT_QR_SECRET` is set in Vercel Production (T3) AND the app has been redeployed.** Env
   changes do not apply to existing deployments — an unredeployed app reads `undefined` and every
   scan returns `ATTENDANCE_NOT_CONFIGURED`.
3. **`event.attendanceStatus` reports ready.** This is the check that distinguishes "secret
   missing" from "index missing" from "flag off", and it is why that procedure exists (D-56).
   Hit it as a head before touching the flag.
4. **Only now flip `events.attendance.enabled`:**

```bash
node scripts/remediation/set-attendance-flag.mjs             # show current — expect OFF/absent
node scripts/remediation/set-attendance-flag.mjs on          # DRY RUN — read the output
node scripts/remediation/set-attendance-flag.mjs on --commit
```

`set-attendance-flag.mjs` is the **only new script in Part C** (D-66), and `on --commit` must
**refuse** unless it can prove `EventAttendance.event_attendee` and
`EventQuestion.event_question` exist, by reading `listIndexes`. **If it does not refuse when the
index is absent, the script is wrong — test that branch deliberately before trusting it.** A
flag that cannot be switched on without its indexes is a stronger control than a checklist item,
and it is the direct answer to "a Prisma `@unique` creates nothing on MongoDB".

**Rollback is step 4 in reverse and nothing else:** `set-attendance-flag.mjs off --commit`. Do
not drop the index and do not unset the secret — both are harmless while the flag is off, and
dropping an index is how the census diff stops being trustworthy.

- [ ] Sequence completed in order. Step that needed a retry, if any: ___

## T9 — Prove `isLiveCcaMember` agrees with the picker, for a real person

**What this protects against:** telling a committee member, at a door, that they are not in
their own CCA.

`UserCCA.userID` is mixed-format, **and membership lives in three places**: `UserCCA` under the
canonical key, `UserCCA` under a legacy A-format key, and the undeclared `User.userCCA` Int[]
array (`services/ccaMembers.ts:102-111`). `routers/user.ts:142-176` records the measurement:
of the 116 users with any CCA data, **37 are ONLY in the embedded array** and 6 are only in the
collection. A membership check that reads either source alone is wrong for roughly a third of
people.

This cannot be verified statically. With access:

1. Pick the CCA used for the trial event (T6).
2. List what the head sees — `cca.memberDirectory` for that `ccaID`.
3. For **each** member, run the `isLiveCcaMember` predicate.
4. **Acceptable result: the two sets are identical.** Any name the picker offers but the
   predicate rejects is a person who would be refused at the door after being nominated, which
   is the exact failure this task exists to catch.

Pay particular attention to anyone whose canonical id is **not** E-format —
`g.s_samuel@u.nus.edu` → `G.S_SAMUEL` is real in this database (`identity.ts:166-173`). If the
implementation gates on `/^E\d{7}$/` anywhere, those people are locked out permanently. That is
**L-27**, and it is the single most likely way this feature quietly excludes real users.

- [ ] Run. CCA used: ___ · directory count: ___ · predicate count: ___ · mismatches: ___

---

## T10 — Prove the door end to end, in this order

Added after Part C was implemented. The order matters: each step makes the next
one meaningful, and doing them out of order produces a green result that proves
nothing.

1. **T1 first** — the `EventAttendance` unique index, *proven to enforce*. Until
   it exists, `checkIn`'s duplicate branch is unreachable: a second scan of the
   same person writes a SECOND ROW, every headcount is silently wrong, and
   nothing errors. `set-attendance-flag.mjs` refuses to turn the flag on without
   it, but that guard is only as good as the proof behind it.
2. **T3** — `EVENT_QR_SECRET` set in Vercel Production and **redeployed**. Env
   changes do not apply to existing deployments. Without it every scan fails
   closed with `ATTENDANCE_NOT_CONFIGURED`, which the door page renders as
   "not set up on this deployment — this is not something you can fix from
   here".
3. **Then** `set-attendance-flag.mjs on --commit`. It also refuses if
   `events.enabled` is not on.
4. Only then a real door.

**Turning it OFF is never blocked by any of these checks**, deliberately — a
kill switch that requires a healthy database to pull is not a kill switch.

- [ ] Run. Result:

## T11 — What only a real door can tell you

Static analysis and a passing build prove nothing here. Specifically unproven
until someone stands at a door:

- **Whether the camera opens on the committee's actual phones.** iOS Safari
  refuses `getUserMedia` outside a user gesture, which is why starting the
  camera is a button. In-app browsers — a link opened inside Telegram or
  Instagram — commonly refuse the camera outright; the page detects the common
  ones by user-agent and says "open this in Safari or Chrome", but that list is
  a guess against a moving target and the fallback for a miss is the manual
  list.
- **Whether a rotating code scans across a window boundary.** The verifier
  accepts the current AND previous 30-second window for exactly this, and that
  path has never executed.
- **Whether the resident being offline is as common as feared.** The rotating
  design requires the resident online to hold a live code. If the manual list
  carries most of a queue, that is the signal to revisit the design, not to
  lengthen the token life.
- **Whether a double scan is idempotent** — this is what T1 protects, and the
  first real double scan is the only honest test of it.
- **Whether a walk-in is recorded and reads as a walk-in afterwards.**

- [ ] Done. Event used, and what actually broke:

## Notes for whoever runs this

Everything in Part C was written against a database nobody could read. Treat
every claim about production as unverified until T5 says otherwise, and prefer
re-measuring over trusting a number written here or in the plan.

A passing `tsc`, lint and `next build` prove nothing about whether a page
renders — this repo's own precedent is five authoring routes that passed all
three plus two adversarial review agents and still threw at render.
