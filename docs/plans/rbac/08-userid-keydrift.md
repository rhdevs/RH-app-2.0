# 08 — userID key drift: the `""` collapse and the A-format join

> **Status:** plan, nothing implemented. Written after the RBAC merge (`1c9d0a1`)
> against a code audit of `main`. Every population figure in here is UNKNOWN
> until §2 runs — this document deliberately does not guess at them.

## 0. What actually happened

The merge replaced the session's userID derivation:

```
OLD  (auth.ts, pre-9cb701b)   (token.email ?? "").toUpperCase().replace("@U.NUS.EDU","")
NEW  (auth.ts)                canonicalUserID(email)      // anchored, trimmed
```

The old form was unanchored, so for a non-NUS address the `.replace()` was a
no-op and it returned **the uppercased full email** — `ALICE@GMAIL.COM`. Garbage,
but *truthy* and *distinct per user*. The new form returns `""` for those
addresses.

So every non-NUS account's runtime identity collapsed from a distinct key onto
the same empty string. Their historical rows are still keyed on the old value.

**The only vector for a non-NUS account is Google OAuth.** `register/route.ts`
has been `@u.nus.edu`-only since the first commit (`ca174cd`, verified unchanged
through `f9d85de`), and `git log -S "async signIn"` returns exactly one commit —
the RBAC merge itself. So between `d1042c5` (Google added) and `9cb701b`, any
Google account of any domain could sign in and `PrismaAdapter` would create a
`User` row with `userID: null`. No seed file exists and no script creates `User`
rows; direct Atlas insertion cannot be ruled out from code.

### 0.1 Two independent problems, often confused

| | **Problem A — the `""` collapse** | **Problem B — the A-format join** |
|---|---|---|
| Who | non-NUS (Google) accounts | ~515 users whose `User.userID` holds an A-format matric |
| Cause | this merge | pre-existing, project Finding #9 |
| Symptom | own-bookings empty, Book button dead, **new rows written with `userID: ""`** | booking rows render with a **blank owner name** |
| Their own bookings | keyed on the old email-ish value, now unreachable | keyed E-format, still reachable — only the *display join* fails |
| Fix owner | this document | `rekey-canonical.mjs`, already written |

They are separate. Fixing one does not fix the other. Do not merge the work.

### 0.2 What `Bookings.userID` actually contains

Settled from git history, contradicting the stale comment at
`facilitiesBooking.ts:146` ("holds User.userID (the matric-style id)"):

`Bookings.userID` is **E-format ∪ uppercased-email**, and has never held an
A-format matric. In the client-supplied era (`bcd238a`) the value came from
`BookingModal.tsx` ← `Calender_v2.tsx` ← `session.user.userID`; in the
server-derived era (`facilitiesBooking.ts:375`) it comes from the session
directly. Same format throughout.

`User.userID`, by contrast, is a **three-way heterogeneous column**: E-format
(register-created), A-format matric (~515 legacy rows), and `null`
(Google/adapter-created). That asymmetry is the whole of Problem B.

**Correct the comment as part of §1.** It currently misleads anyone reasoning
about this join.

---

## 1. P0 — stop the bleeding (ship before anything else)

These are small, self-contained, and prevent *ongoing* damage. They do not
depend on §2's measurement.

### 1.1 The `""` write hazard — the urgent one

`evaluateBookingWithMode` (`access.ts:414-424`) returns from the `mode === "off"`
branch **before** reaching the `!userID` check, and `canBookLegacy` (`:314`)
returns `true` when `requiredRoles` is empty. In the shipping default config
(`off`), a non-NUS user can therefore still **successfully create a booking that
writes `userID: ""`**.

Those rows are invisible to their creator, and they collide with each other in
the `userDict` join at `facilitiesBooking.ts:215-230` — every `""`-keyed booking
resolves to whichever `""`-keyed user the dict happened to land on.

1. Hoist the empty-userID rejection **above** the mode branch in
   `evaluateBookingWithMode`, so it applies in `off`, `permissive` and `enforce`
   alike. An empty identity is not a policy question — there is no mode in which
   writing an unattributable booking row is correct.
2. Return a distinct reason code (`NO_IDENTITY`, not `NOT_RESIDENT`) so the
   shadow-denial log distinguishes "this user has no canonical id" from "this
   user lacks the baseline". They need different remediation and conflating them
   will corrupt the `permissive → enforce` go/no-go signal.
3. Adjacent one-liner: `access.ts:437` writes `actorUserID: userID ?? "(anon)"`,
   but `""` is not nullish, so audit rows record `""`. Use a falsy check.

**Done when:** a session with `userID === ""` cannot create a booking in any
mode, and the denial is audited as `NO_IDENTITY`.

### 1.2 Silent failures — make them legible

Every affected surface currently fails *silently*, which is why this went
unnoticed. Ranked by how misleading each is:

| Site | Now | Should be |
|---|---|---|
| `BookingModal.tsx:78` | `if (!userId) return;` — Book button **dead, console only** | Surface the error; never a no-op click |
| `PastBookings.tsx:97-102` | `enabled: !!userID` → disabled query reports `isLoading:false` → **"No bookings found" forever** | Distinguish "no identity" from "no bookings" |
| `Calender_v2.tsx:93` | "See My Bookings" **blanks the calendar** | Same |
| `Calender_v2.tsx:108-111` | `getFacilitiesForBooking` disabled → `:131` **fails open, every room bookable** | Deliberate today; revisit once §1.1 blocks the write anyway |

`profile/page.tsx:42` is the one site that already handles this correctly — it
branches on `userID` (via `user.ts:90-98`) rather than on `eligible`, and renders
a dedicated panel. **Copy that pattern**; do not invent a second one.

> **Why `eligible` is the wrong thing to branch on.** `auth.ts:310` sets
> `eligible = userID !== "" || mode !== "enforce"`. With the auth switch at its
> default `off`, a non-NUS user is `eligible: true` **with an empty `userID`**.
> `protectedProcedure` (`trpc.ts:123-147`) checks only `eligible`, so they pass
> every server gate carrying an empty identity. `MatricGate.tsx:50` needs
> `eligible === false`, so `/onboarding/ineligible` is unreachable in the default
> config. Any fix that keys off `eligible` will therefore no-op. **Key off
> `userID === ""`.**

### 1.3 Not in scope, but found next door

- `post.ts:28-31` does `where: { id: ctx.session.user.id }` against `Posts` —
  querying a Post by ObjectId using the *User's* ObjectId. Broken for
  **everyone**, unrelated to this work. Log it; fix it separately.
- `Calendar.tsx:17-21` calls `getBookings` with no `useSession` and no `enabled`
  guard. No `page.tsx` imports it; possibly dead. Confirm before touching.

---

## 2. P1 — measure, before choosing a remedy

**Nothing below §2 can be decided without this.** The remedy differs completely
depending on whether the non-NUS population is zero, junk, or real people.

Use the tooling that already exists — do not hand-roll queries:

```
node scripts/remediation/rbac-doctor.mjs
```

It is read-only, lists non-NUS users (`:78`), and computes orphans under the old
key across `Bookings` / `UserCCA` / `UserMatric` / `UserRole` (`:116-129`) using
`legacyCanonicalUserID` (`lib/rbac.mjs:135`), which is certified byte-identical
to the pre-merge derivation.

Two things the doctor does **not** cover, needed here:

1. **Rows owned per collection, and by whom.** The historical key for a non-NUS
   user is simply `email.toUpperCase()`. Also check `SupperGroup.ownerId` *and*
   `SupperGroup.userIdList`.
2. **`""`-keyed rows already written** by the §1.1 hazard — `Bookings` grouped by
   `userID`, filtered to values matching neither E-format nor any live user.

Copy-pasteable snippets for both are in the audit; they belong in a
`--nonnus` flag on the doctor rather than in someone's shell history.

> **Caveat the audit was explicit about.** This repo contains write sites for
> only `Bookings`, `UserMatric`, `UserRole`, `CcaHead`, `PendingRoleGrant`,
> `RoleAuditLog` and `User`. `Gym`, `Order`, `SupperGroup`, `Posts`, `UserCCA`,
> `FoodOrder` and `BookingLogs` are written by the **Python backends on the
> droplet**, not here. Their key formats are undeterminable from this codebase.
> If any of them turn out to be keyed on the legacy email-ish value, remediation
> has to be coordinated with those services — that is a scope expansion, not a
> detail.

**Done when:** you have (a) the non-NUS user list, (b) their row counts per
collection, (c) the count of `""`-keyed rows, and (d) a format census for the
droplet-owned collections.

---

## 3. P2 — remedy, branching on §2

### Branch A — the list is empty

Most likely outcome given registration has always been NUS-only. Then Problem A
is theoretical: no user is affected, no re-key is needed.

- Keep §1 anyway — it closes the hazard permanently and costs nothing.
- Record the measured zero in this document, with a date.
- Proceed to the auth switch rollout (`off → permissive → enforce`) unblocked.

### Branch B — junk accounts only (`test@`, `aaaaaa@`, and similar)

The docs already note the `User` collection contains such rows.

- Delete them. **Read `cascade.ts` first** — `07-cca-future.md` §5 documents a
  hazard where deleting a user leaves a live `UserRole` row, and a later account
  re-created from the same email inherits its roles. Deletion must clear
  `UserRole` / `UserMatric` / `CcaHead` too.
- Back up before deleting (`backup-role-collections.mjs`).
- No re-key needed; nothing of value is keyed on those ids.

### Branch C — real people with real data

Only then is a re-key warranted, and it needs a **stable key for an identity
that has no canonical NUS id**. This is the same open question the schema agent
flagged and deliberately left unresolved:

> `AuthAllowlist` is specified inconsistently across the plan set — `00-overview`
> §2.4 describes a collection with an `EXT:`-namespaced `pinnedUserID`,
> `02-backend-authz` specifies it as env-var-only, and `01-data-model` Step 7
> omits it entirely, calling the variant choice "an open contradiction to resolve".

Resolving it here is the natural place, because this is the first concrete need
for it. Sketch, to be designed properly if this branch is reached:

1. `AuthAllowlist { email @unique, pinnedUserID, addedBy, addedAt }`, where
   `pinnedUserID` is `EXT:<stable-slug>` — namespaced so it can never collide
   with an E-format id and is greppable in any collection.
2. `canonicalUserID` consults it only for addresses failing the domain rule, so
   the hot path for NUS users is unchanged.
3. A re-key migration rewriting `email.toUpperCase()` → `EXT:<slug>` across every
   collection §2(d) proved is affected, dry-run first, per-collection counts
   reported, `--commit` gated.
4. **`EXT:` identities receive no `resident` baseline** — I-8d already forbids it,
   and that must stay true. They can sign in and see their history; they cannot
   book once enforcement is on. If they *should* be able to book, that is a
   policy decision to make explicitly, not a side effect of a migration.

**Decision required before building any of this:** is a non-NUS person who
should retain access a real case for this hall, or should those accounts be
merged to the person's NUS address instead? `merge-accounts.mjs` already exists
and is the cheaper answer if the person *has* an NUS address. Branch C is only
warranted for someone who genuinely has none.

---

## 4. P3 — Problem B, tracked separately

The A-format display join (Finding #9). Independent of everything above.

- `rekey-canonical.mjs` already exists and is sign-off gated.
- Note `merge-accounts.mjs:509-557` pre-seeds `UserMatric` keyed on the
  **A-format** id — which un-gates those users at login but does *not* repair the
  drift, and itself writes a non-canonical key. Fold that into the re-key, or it
  will be re-introduced.
- Fix the stale comment at `facilitiesBooking.ts:146` per §0.2 while here.

---

## 5. Sequencing

| Step | Depends on | Reversible |
|---|---|---|
| §1.1 `""` write hazard | nothing | yes |
| §1.2 legible failures | nothing | yes |
| §2 measure | §1 shipped (stops the population growing) | read-only |
| §3 remedy | §2 | branch-dependent; C is a migration, back up first |
| §4 A-format re-key | independent | one-way, sign-off gated |
| auth switch `off → permissive → enforce` | §2 clean, or §3 complete | 15s revert |

**Do not flip the auth switch to `enforce` before §2 and §3 resolve.** That is
the step that converts a silent, recoverable emptiness into a hard sign-in
denial for exactly the population this document is about.

## Done when

- [ ] No session with `userID === ""` can write a booking row, in any mode.
- [ ] `""`-keyed `Bookings` rows: counted, and cleaned or attributed.
- [ ] No affected surface fails silently; all match `profile/page.tsx`'s pattern.
- [ ] The non-NUS population is **measured**, not assumed — figure and date
      recorded in §3.
- [ ] Key-format census exists for the droplet-owned collections, or their
      exclusion is justified in writing.
- [ ] `facilitiesBooking.ts:146`'s comment corrected.
- [ ] Branch A / B / C chosen on evidence, and the `AuthAllowlist` contradiction
      resolved if and only if C is reached.
