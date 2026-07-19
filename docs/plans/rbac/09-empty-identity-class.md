# 09 — Sentinel-as-value: the class behind the `""` collapse

> **Status:** plan, nothing implemented. Sibling to
> [`08-userid-keydrift.md`](./08-userid-keydrift.md), which covers the *incident*
> — the `""` collapse and the A-format join. This document covers the **class**:
> every other place in the codebase where an absent identity is spendable as a
> real one.
>
> **No production data has been measured for this document.** Every figure below
> is named as a query, not asserted as a number. §4 says which query produces
> which figure.
>
> Read 08 first. This document does not repeat 08's §0 (what happened), §2
> (the measurement plan) or §3 (the re-key branches), and defers to it on all
> of them.

---

> ## Deployment question: SETTLED — the leaks never reached production
>
> Resolved from git, not from the Vercel dashboard, and it needs no further check.
> `git log origin/main..main` shows **6 unpushed commits**; the newest commit on
> `origin/main` is `f25b08c` (2026-07-17, the password-reset cooldown). Every
> commit in this work — the RBAC merge `9cb701b`, the fix `7a27304`, and the
> merges around them — exists **only in the local repository**. Vercel deploys
> from the remote, so none of it has ever been built or served.
>
> Therefore **LEAK 1 and LEAK 2 were never live**, no user was ever exposed by
> them, and §4's damage assessment is contingency planning for a scenario that
> did not occur. There is no disclosure question arising from those two leaks.
>
> **This does NOT clear §2.3 (`getBooking`).** That finding predates all of this
> work — `publicUserSelect` including `telegramHandle` is present at `f25b08c`,
> the currently-deployed commit — so it *is* live in production right now, and it
> is reachable by any authenticated user, with no dependency on an empty
> identity. It is the only item here with a live production exposure, and it
> should be read as the headline finding of this document.

## 0. The class, in two sentences

A value meaning *"no identity"* is represented by an in-band member of the
identity's own value domain — `""` for a string key, `0` for an `Int` key,
`null`/`undefined` for an optional one — and is then **spent**: passed into a
Prisma filter, an equality comparison, a dictionary lookup, a membership test,
or a write, by code that was only ever sound for a genuine identity. Because the
sentinel is a legal member of the domain, every one of those operators succeeds,
and the result is **indistinguishable from success**.

### 0.1 The reviewer's predicate

For an expression `E` reading an identity-ish value `k`, `E` is in the class iff
all three hold:

1. **Reachability** — `k` can hold its absent-marker at runtime on some reachable
   path, with a real producer. In this repo the producers are `canonicalUserID()`
   returning `""`, `session?.user?.userID` being `undefined`, `User.userID` being
   `null` on adapter-created rows, and `Int` business keys whose zero is legitimate.
2. **In-band-ness** — the marker is a legal member of the domain the operator
   ranges over. `"" === ""` is true. `where: { userID: "" }` is a legal, *matching*
   filter. `where: { userID: undefined }` is a legal, *omitted* filter. `dict[""]`
   is a legal key. `ccaID: 0` is a legal `Int`.
3. **No guard dominates** — no `if (!k) return/throw`, or equivalent
   `Boolean(k) &&` conjunct, on every path into `E`.

Then the disambiguating question that sets severity:

> **When `k` is absent, does `E` evaluate to something indistinguishable from success?**

Yes → this class. No — it throws, 403s, or returns a `null` the caller checks →
an ordinary nullability bug, not this.

### 0.2 Why it was invisible

**TypeScript cannot see this class at all.** `session.user.userID` is typed
`string`, non-optional, and `""` is a perfectly valid `string`. This is the single
most important property of the class and the reason a compiler pass was never a
substitute for the sweep — the type system is not merely silent, it is *actively
reassuring*.

Compounding that:

- **Every instance was correct when written.** Not one is a typo. Each was sound
  under a global invariant — *"the identity key is never empty"* — that was never
  written down, never asserted at a boundary, and was revoked by a change in a
  **different file**. The class is defined not by a bad line but by an unguarded
  dependency on an unstated invariant.
- **`eligible` is not a proxy for identity.** `session.user.eligible` is `true`
  with an empty `userID` whenever the auth kill switch sits at its default `"off"`.
  The one flag that *looks* like it means "has an identity" does not (08 §1.2).
- **`""` accumulates.** The write hazard in 08 §1.1 manufactures the very rows the
  reads then over-match. The population of victims and the population of attackers
  are the same set, and it grows on its own.

### 0.3 Neighbouring classes — do not conflate

| Not this class | Tell |
|---|---|
| Null-pointer / undefined-deref | It **throws**. This class never throws. |
| Missing authorization check | The guard was never there. Here the guard exists and is *satisfiable by an empty value*. |
| IDOR / client-supplied id | The attacker controls the id. Here the id is server-derived and *correct* — the bug is that it is correctly **empty**. |
| Type-level nullability | `strictNullChecks` finds it. See §0.2. |
| Data-quality / heterogeneous key (Problem B, 08 §0.1) | **Under**-match: a visible wrong answer (blank owner name). This class **over**-matches: a false success. |
| `??` vs `\|\|` generally | Only in-class when the falsy-not-nullish value is an *identity* whose absence is then spent. `count ?? 0` is fine; `actorUserID: userID ?? "(anon)"` is in-class. |

**Ordering principle for everything below: over-match beats under-match.** A key
that matches too much is a breach; one that matches too little is a visible bug
someone reports.

---

## 1. The worked example — the four fixed sites

All four were fixed in `7a27304`. They are here as the *pattern*, not as open work.

| # | Site | Shape | Silent invariant revoked |
|---|---|---|---|
| 1 | `getUserBookings` (`facilitiesBooking.ts`) | `where: { userID }` with `userID === ""` | *a caller's `userID` names at most one principal* |
| 2 | `getBookings` `userTeleHandle` ternary | `booking.userID === callerUserID` | *equality of identity keys implies identity of principals* |
| 3 | `deleteBooking` ownership check | same equality | same |
| 4 | `updateBooking` ownership check | same, via `session?.user?.userID` | same |

Three observations that generalise:

**Three of the four were themselves security fixes** (`#8` "never take a
client-supplied owner id", `#10` "stop broadcasting Telegram handles", and a prior
hardening of `deleteBooking`'s short-circuit order). This class does not live in
sloppy code. It lives in carefully reasoned code whose reasoning had an unstated
premise, and it is introduced by a change that is locally correct **in another
file**. No amount of care at the call site prevents it; only asserting the premise does.

**The sharpest lesson is an asymmetry inside site 3.** Its admin arm was never
the hole — `getUserRoles` has `if (!userID) return []` (`access.ts:241`), so
`isAdmin("")` was already false. The role-read boundary was guarded; the ownership
boundary was not. **Someone had already had this exact thought, in this exact
file's dependency, and it did not propagate.** The sweep's real target is the set
of boundaries the thought has not reached.

**Site 4's optional chaining makes it worse, not safer.** `?.` yields `undefined`,
and a refactor moving that expression into a `where` clause converts it from a
false-equality into *returns the entire table*. The defensive-looking idiom is a
hazard multiplier.

### 1.1 The thirteen shapes

Referred to as S1–S13 throughout. Full sketches omitted; the failure mode is the
part that matters.

| | Shape | Wrong behaviour |
|---|---|---|
| **S1** | `""` as a Prisma filter | **Returns other people's rows** (leak 1) |
| **S2** | `undefined` as a Prisma filter | **Returns the entire table** — Prisma *omits* the condition |
| **S3** | Equality in an authorization decision | False authorization pass |
| **S4** | Equality gating field-level disclosure in a list | PII leak, N rows per request (leak 2) |
| **S5** | Dict/Map/Set keyed on a possibly-empty identity | Distinct principals collapse; a stranger's record wins |
| **S6** | `findUnique` on a shared sentinel row | One row serves a whole cohort |
| **S7** | `??` fallback that never fires | Forged sentinel written to storage |
| **S8** | Unattributable **write** | Manufactures the orphans every other shape reads |
| **S9** | `deleteMany` on a sentinel | Irreversible mass deletion |
| **S10** | Array membership containing the sentinel | False group membership |
| **S11** | `enabled: !!k` in react-query | Silent empty state, indistinguishable from real |
| **S12** | Client-side identity equality | Wrong affordance; one refactor from S3 |
| **S13** | Stringified absence as a key (`"rl:undefined"`) | Shared rate-limit / lock bucket |

**S2 is the highest-yield shape to sweep for** and the one the four fixed sites
did *not* include: it is strictly worse than S1 (whole table, not just the orphan
cohort) and it is reached through exactly the `?.` idiom that looks defensive.
The repo already contains the correct counter-idiom to hold sites to —
`getBookings` uses `...(userId ? { userID: userId } : {})`, spread-conditional.

**S8 is Tier-3 by direct impact and Tier-0 by leverage.** Closing writes caps the
orphan cohort permanently; closing reads only caps today's exposure. **Sweep
writes before reads.**

### 1.2 The identity keys, and why some are safe

The useful cut is not "can it be absent" but **"is the absent state
distinguishable from a legitimate value."**

*In-band absence — full class members:* `session.user.userID` (`""` **and**
`undefined`, with *different* Prisma semantics — check both); `Bookings.userID`
(`""` writable via S8, and indexed, so `""` queries are fast and unlogged);
`User.userID` (`null`, out-of-band for `===` but in-band for `Object.fromEntries`
→ key `"null"`); `Bookings.ccaID` / `CCA.ccaID` and `facilityID` (`0` — the pure
numeric twin); the interpolated `RateLimit.key` / `BookingLock.key` /
`Counter.key`; `RoleAuditLog.actorUserID`; `SupperGroup.userIdList[]`.

*Out-of-band absence — safe, assert it and move on:* `User.id` (ObjectId — Prisma
**throws** on `""` rather than matching, so it fails loudly); `UserMatric.matric`
(format-validated at its only write path, read only through `Boolean(record?.matric)`);
`SystemFlag.value` (validated against a closed set with a documented default);
`telegramHandle` (`""` means *clear*, an explicit intended meaning encoded once).

> **The whole class in one sentence.** Every safe key is safe for exactly one
> reason — **absence was given a representation outside the value domain**. Every
> dangerous key is dangerous for exactly one reason — absence was encoded as a
> member of it. That is also the shape of the durable fix: not more guards, but
> moving absence out of band. See §5.

**Numeric caveat for whoever fixes the `Int` cases:** `if (!ccaID)` is the **wrong
guard** — it also rejects a legitimate zero. The numeric case needs `ccaID == null`.

---

## 2. Confirmed findings, ranked by blast radius

These survived adversarial verification. Each has a reproduction; anything without
one is in §3 or was refuted (§3.3).

### 2.1 `[HIGH]` `merge-accounts.mjs` re-keys non-NUS users onto a dead key — **unrun, and the only open recoverability window**

**`scripts/remediation/merge-accounts.mjs:83-85`**, spent at `239, 286, 403, 406, 410`.

```js
/** EXACT mirror of the auth.ts session-callback derivation, quirks included. */
function deriveCanonical(email) {
  return (email ?? "").toUpperCase().replace("@U.NUS.EDU", "");
}
```

**Verified present in the working tree at those lines.** The docstring's claim was
made false by `9cb701b` and no gate re-checks it. This is **the same invariant
revocation as the incident, replicated in an unrun migration** — correct when
written, invalidated by a change in a different file.

**Reproduction.** Two `User` rows share a non-NUS email (`alice@gmail.com`) — e.g.
a credentials row with `userID: "A0234567X"` and a Google-adapter row with
`userID: null` — and at least one has a `passwordHash` (so `NO_HASH_IN_GROUP` does
not fire). Alice has `Bookings` / `Gym` / `UserCCA` rows keyed `"A0234567X"`. The
operator follows `README.md` "Step: merge accounts (#16)" and runs
`APPLY=yes node scripts/remediation/merge-accounts.mjs`.

1. `deriveCanonical("alice@gmail.com")` → `"ALICE@GMAIL.COM"` (truthy), so
   `EMPTY_CANONICAL` does not fire. `NON_NUS_EMAIL` fires at `:249-250` **but is
   not in the skip set at `:281-283`**, so the group is applied.
2. `reassignRaw` (`:403`) issues `multi:true` `$set { userID: "ALICE@GMAIL.COM" }`
   across `Bookings`, `Posts`, `Order`, `UserCCA`, `Gym`.
3. `:406` sets the keeper's `User.userID` to that string; `:410` upserts
   `UserMatric` under it; `:416` deletes the other `User` row.
4. Verification (`:429-476`) recounts **against its own `canonical`**, sees
   conservation, prints `[OK]`. The script reports complete success.
5. Alice signs in. `auth.ts:302` computes `canonicalUserID("alice@gmail.com") === ""`.
   Her merged data now sits under a key **no session will ever produce again**, and
   the duplicate row that would have allowed hand reconciliation is deleted.

**Why this ranks first.** It is a one-way write over real user data; the failure is
silent and self-confirming; and the backup at `:330-348` captures only `User` docs,
**not dependent rows' prior `userID`** — so for a group with ≥2 source IDs the split
is unreconstructable afterwards. Contrast `rekey-canonical.mjs:74-83`, which aborts
on an empty target key with *"There is no key this script could write that would be
right"* — the correct conclusion, which `merge-accounts.mjs` cannot reach because
its derivation launders `""` into a truthy string first.

### 2.2 `[HIGH]` the same script seeds the `""`-keyed `UserMatric` row

**`merge-accounts.mjs:523-551`** (singleton A-format block), canonical derived at
`:527`, spent at `:544-545`. Runs **unconditionally under APPLY** — not gated on
the merge's failure list.

**Precondition (UNVERIFIED — must be checked first):** exactly one `User` document
whose `email` is the literal empty string `""` (not missing, not `null` — those abort
harmlessly) and whose `userID` matches `/^A\d{7}[A-Z]$/`. Query in §4 (Q6).

Given it: `deriveCanonical("") === ""`, and `:540-550` upserts
`{ userID: "", matric: "<a real person's matric>" }`. The `UserMatric.userID` unique
index (`schema.prisma:431`) permits exactly one such row, so it lands and is permanent.

This **manufactures the row `auth.ts` calls a red line** — its session callback takes
an early return at `:315` specifically so it never issues a `""`-keyed lookup — and
converts §2.4 from latent to live.

### 2.3 `[MEDIUM]` `getBooking` has no ownership check at all — **live, and it defeats the shipped fix**

**`src/server/api/routers/facilitiesBooking.ts:141-176`. Verified against source.**

`getBooking` is a `protectedProcedure` taking a bare `z.number()` bookingID. It joins
`publicUserSelect` — verified at `:22-29` to include **`telegramHandle`, `bio`,
`block`, `userID`** — and applies **no ownership check whatsoever**.

**Reproduction.** Any signed-in `@u.nus.edu` user, with no special role, no empty
identity and no legacy data, issues
`GET /api/trpc/bookings.getBooking?input={"json":1}` and increments the integer
across the sequential bookingID space. Every response's `user` object contains that
booking owner's Telegram handle and bio.

**This is leak 2's payload, reachable by a route `7a27304` did not touch.** The
careful `Boolean(callerUserID) && booking.userID === callerUserID` gate added to
`getBookings` is bypassed entirely by iterating bookingIDs here.

**Honest classification:** this arm is a **missing-authorization bug — the
neighbouring class in §0.3, not sentinel-as-value.** It is reported because the
sweep found it and because it defeats the shipped fix, not because it is a class
member. (The file *also* has the S1/S5 sentinel over-match at `:160-163`: a
`""`-keyed booking joins to a `""`-keyed `User` and returns a stranger's row. That
arm is in-class and latent on the orphan cohort.)

### 2.4 `[LOW, latent]` `getMatricStatus` is the unguarded twin of two guarded siblings

**`src/server/api/routers/user.ts:166-173`** — `userMatric.findUnique({ where: { userID } })`
with no guard (S6).

**Today it returns `null`**; no `""`-keyed row exists. It is a **latent** finding, and
the sweep's rule is that *"a `""`-keyed row cannot exist yet" is a latent finding, not
a non-finding* — especially here, where §2.2 is the producer sitting in an unrun script.

**Reproduction (two parts, part (a) currently unsatisfiable).** (a) A `UserMatric`
row with `userID: ""` must exist. The only in-app writer refuses to create it —
`setMatric` (`user.ts:194`) throws on `!userID`. It arises from a direct
mongosh/Compass write, a future unguarded writer, or §2.2. (b) Given it: any user on
a non-`@u.nus.edu` address, with `rbac.auth.enforcement` at its default `"off"`
(today's config), calls `user.getMatricStatus` directly — no UI in `src/` calls it.
`protectedProcedure` admits them because `eligible` is true; the response is
`{ hasMatric: true, matric: "<a real stranger's matric>" }`, indistinguishable from
their own record.

**The asymmetry is the point, and it is visible within one file:** `getCurrentUserData`
(`:90`) guards, `setMatric` (`:194`) guards, `getMatricStatus` does not.

### 2.5 `[MEDIUM]` `MatricGate` applies no gate at all to the empty-identity cohort

**`src/app/_components/MatricGate.tsx:50`.** For `userID === ""`, `redirectTo` is
`null`, `blocked` is `false`, children render normally.

This is **the gate's own stated contract failing**. Its docstring asserts INELIGIBLE
"MUST be checked first"; `auth.ts:335` asserts "MatricGate routes ineligible users to
the ineligibility page before it ever consults hasMatric". Both are load-bearing
comments resting on an invariant (`eligible === false` iff `userID === ""`) that
making `eligible` flag-aware revoked.

**Reproduction.** Both kill switches at shipping default. Any user whose email is not
`@u.nus.edu`, or any live pre-cutover JWT (`session.maxAge` is 30 days and `signIn`
does not re-run for a live token).

1. Sign in: `auth.ts:302` → `userID = ""`; `:310-311` → `eligible = true`;
   `:338` → `matricRequired = false`.
2. `MatricGate:50-62` → `ineligible=false`, `needsMatric=false`, `blocked=false`. The
   full app renders with no gate and no warning.
3. Book any facility with empty `requiredRoles`. `protectedProcedure` passes
   (`eligible`), `matricProcedure` passes (`isMatricRequired` false),
   `evaluateBookingWithMode` at `"off"` allows, and `:448-461` writes
   `Bookings.userID: ""` — **this is S8, the generator.**
4. The UI reports success. `getUserBookings` (`:336`) shows the user nothing;
   `deleteBooking` (`:493`) and `updateBooking` (`:542`) both deny ownership. **The
   row is invisible and uncancellable to its creator, yet the conflict check at `:426`
   enforces it against everyone else.** The slot is silently locked with no in-app
   path to release it.

**Secondary observable, same session:** `/profile` renders the ineligible panel
(`user.ts:90-97` derives `eligible: false` from `!userID`) while `MatricGate` treats
the identical session as fine. **Two definitions of one word, visible to the same
user at the same time.**

### 2.6 `[MEDIUM]` `AuditLogTable` filter fails open — the forensic surface lies in both directions

**`src/app/admin/_components/audit/AuditLogTable.tsx:99-100`** (S2, client-side).

**Reproduction.** An admin on the audit-log page copies an E-format id from a
spreadsheet cell or another admin table — any source carrying a **trailing space** —
and pastes `E1234567 `. The box looks correct (a trailing space is invisible; the value
is already uppercase so `onChange` changes nothing). `/^E\d{7}$/.test("E1234567 ")` is
false, the ternary substitutes `undefined`, tRPC omits the key, `admin.ts:1356`
evaluates `...(input.targetUserID ? {...} : {})` to `{}`, and `findMany` runs with an
empty `where`.

**Observed:** the table fills with the 50 most recent audit rows for **every** user,
plus batch accordions and a "Load more" button. No error, no empty state, no indication
the filter was dropped. The operator reads unrelated grants and revocations as the role
history of the person they are investigating.

**The client guard is stricter than the server contract and fails open on the
difference** — `userIDSchema` calls `.trim()` before the regex, so the server would
have *accepted* this string. Same trigger from an A-format matric (~515 exist, so an
investigating operator plausibly has one to hand) or an email address.

Contrast the correct siblings on the same lines: `action: action || undefined` and
`batchId: batchId || undefined` are *intentionally* omit-when-blank. The two identity
filters reuse that idiom for a case where omission is not the intent.

### 2.7 `[MEDIUM]` `/api/register` — whitespace email creates an unloggable duplicate

**`src/app/api/register/route.ts:60, 96, 101`** (with the trim in `src/lib/identity.ts:41-42`).

**Reproduction.** A direct POST to `/api/register` (not the form, whose
`<input type="email">` strips whitespace) with `"email":" e1234567@u.nus.edu "`.
`isNusStudentEmail` trims and passes. The duplicate probe at `:77-84` uses
`mode: "insensitive"` — **a collation that folds case, not whitespace** — so it misses
the existing clean row. A second `User` row is created with the spaced email and the
**identical** `userID: "E1234567"`.

Two compounding effects:

- **Permanent credentials lockout.** `auth.ts:162-165` parses the login form with
  `z.string().email()`, which *rejects* leading/trailing whitespace; the unspaced
  address does not match the spaced stored row. The account just created can never be
  logged into. Registration returns 201.
- **It survives the migration meant to end duplicates.** `dedupe-users.mjs:110-118`
  creates a case-insensitive unique index at collation strength 2 — again folding case,
  not whitespace. It neither catches nor removes these.

Downstream: `facilitiesBooking.ts:160`/`:347` does `findFirst({ where: { userID: "E1234567" } })`
against two matching rows with unspecified ordering, so a booking may display the
attacker-supplied `displayName` as the owner. Same outcome in the reverse order.

### 2.8 `[MEDIUM]` four admin surfaces assert a confident falsehood on a failed read

All S11. Grouped because the fix is one pattern applied four times: **distinguish
"could not load" from "there is nothing".**

| Site | The false statement |
|---|---|
| `bulk/PendingGrantsPanel.tsx:79, 214-220` | **"No deferred grants outstanding."** These are bearer credentials that auto-apply `admin`/`jcrc` at first sign-in. The expiry warning banner (`:109`) vanishes at the same moment, from the same empty array. |
| `audit/AuditLogTable.tsx:206-212` | **"No role changes recorded yet"** over a failed read of an append-only audit log — an affirmative all-clear about the system's history, while the log may be full of denials. |
| `health/SystemHealthPanel.tsx:87-93` | A permanent **"Loading health…"** that never resolves and never admits failure. Lost with it: the red `residentBaselineMissing` tile — **the one gate on the enforcement flip** — the shadow-denial count, and the enforcement-mode selector. |
| `facilities/FacilityAccessTable.tsx:79-80, 130-136` | Headers over zero rows, reading as "no facilities configured". The amber "N facilities have no access rule" alert derives from the same empty array, so **the fail-safe warning disappears exactly when the data is unavailable**. |

**Reproduction (PendingGrantsPanel, representative).** An `admin`/`jcrc` opens
`/admin/bulk` with at least one unclaimed grant in `PendingRoleGrant`. The panel's
*first* fetch fails after react-query's 3 default retries — flaky campus wifi during
navigation, or a Vercel cold start plus an Atlas hiccup rendering the tRPC call a 500.
`status="error"`, `data=undefined`, `isLoading` computes false, `data ?? []` → `[]`,
`!isLoading && rows.length === 0` → EmptyState. The operator who opened this page
*specifically to audit outstanding privileged bearer credentials* is told there are
none, with no error alert and no visual difference from a genuine empty table, while an
unclaimed `admin` grant expiring in 3 days sits in the database. The `error` Alert at
`:103` stays hidden because only mutations write that state.

*Does not reproduce if the query ever succeeded* — react-query keeps previous data on
a later failure. **The bug requires the initial load to fail.**

`SystemHealthPanel` reproduces differently and more easily: leave `/admin` open past
JWT expiry, then change a facility rule or the enforcement mode — either calls
`utils.admin.systemHealth.invalidate()`, the refetch throws UNAUTHORIZED, and the panel
is permanently lost. `profile/page.tsx:87-103` is the correct pattern already in the
repo (isError branch + "Try again"); copy it, per 08 §1.2.

**Why these matter despite being unable to leak anything:** they hide Tiers 1–2 from
the only people positioned to report them, and in three of four cases the vanished
element is a *safety warning* derived from the same empty array as the all-clear.

---

## 3. Not confirmed — stated as such

### 3.1 Unverified (found by sweep, **not** adversarially verified)

Listed so they are not lost, explicitly **not** carrying the confidence of §2. Each
needs a reproduction before it becomes a finding.

- `facilitiesBooking.ts:227-242`, consumed at `:310` — the `userDict` **S5 collapse is
  still live**. `7a27304` fixed the `userTeleHandle` ternary at `:320-323` and left the
  dictionary and the `displayName` read one line above untouched: every `""`-keyed
  booking still renders with a stranger's `displayName`. Two class members were stacked
  in one expression and one was fixed. **Highest-priority item in this subsection.**
- `facilitiesBooking.ts:215` — `getBookings`' `userId` filter vanishes on `""` (S2,
  server-side). Held closed *today* by two client files (`enabled: hasIdentity`); a
  hand-crafted request with `userId: ""` gets the dump. The correct server behaviour for
  an empty `userId` is an empty result, not an omitted filter.
- `facilitiesBooking.ts:381, 410-415, 448-462` — `facilityID: -1` (or any nonexistent
  int) is written and returned as success; the row is unreachable through every UI
  picker, renders titleless in others' calendars, and takes the `facility:-1` advisory
  lock, serialising real traffic against a pseudo-facility.
- `facilitiesBooking.ts:167, 355` — if the droplet ever creates a CCA with `ccaID 0`,
  every personal booking is silently attributed to it. **Unverified cross-service
  assumption:** that the droplet reserves `0`. Nothing here enforces or detects it.
- `admin.ts:1688, 1837` / `:1507` / `:2120` / `:808-818` — S3/S6/S13 shapes in the admin
  router, **all gated today by one accident**: `roleManagerProcedure` reads
  `session.user.roles`, and `auth.ts:339` hardcodes `[]` on the `userID === ""` branch,
  so no empty-identity caller can reach them. That guard is one branch in a different
  file, not a check on these lines. The entire admin router's sentinel exposure rests on
  `access.ts:241` plus one session-callback early return — **a single unstated invariant
  with no assertion at any of these boundaries, which is precisely the structure §0
  defines.**
- `admin.ts:728-750` — a `jcrc` can self-assign `cca_head`: `grantCcaHead` requires only
  the `manageCcaHeads` capability (granted to `admin` **and** `jcrc`) and never compares
  actor to target, bypassing `assertCanMutateRoles:441`'s `CANNOT_SELF_ASSIGN`. **Not a
  class member — an authorization-model gap found in passing.** Worth its own ticket.
- `cascade.ts:18, 28, 35, 46-50` — the only `deleteMany`-on-a-sentinel in the repo (S9).
  `deleteCcaCascade(0)` would wipe every personal booking; `deleteUserCascade("")` the
  whole orphan cohort. **Grep confirms zero call sites — this file is dead code**, which
  is why it is here and not in §2 (see §3.3). Listed because it becomes reachable the
  moment an admin delete button is wired to it. Also `:33-43`: a deleted user's roles
  survive and are re-inherited (already in `05-verification.md:613`).
- `rateLimit.ts:62-66`, spent at `register/route.ts:21` and
  `reset-password/request-verification-code/route.ts:35` — S13 shared bucket. An empty IP
  collapses the 10/hr registration and 20/15min reset caps to **global**, so one actor
  locks out everyone. The intended sentinel `"unknown"` has the identical property *by
  design*. Marked theoretical only because Vercel normally sets `x-forwarded-for` — **no
  code in this repo asserts a trusted-proxy invariant**, so the guarantee is entirely
  external to the artifact.
- `dedupe-users.mjs:28-36, 41` (duplicated at `merge-accounts.mjs:100-108`) — a missing
  `createdAt` silently sorts as `0`, i.e. *"we do not know when this was created"* is
  read as *"this is the oldest"*, deciding which `User` document survives `db.user.delete()`.
  Held down by the mixed-userID abort at `:85-96` — **which is bypassable by
  `FORCE_UNSAFE_DELETE=yes`**, and which `merge-accounts.mjs`'s `bestField` has no
  equivalent of.
- `merge-accounts.mjs:67-69` — `SupperGroup.ownerId`/`userIdList` are not reassigned, so
  after an APPLY the user loses their groups **and** the abandoned userID string stays
  live in a `String[]` on the droplet side (S10). A coverage gap, not a guard gap — the
  script otherwise correctly skips `EMPTY_CANONICAL`.
- Client cosmetics, listed for the census only, no action implied: `Calender_v2.tsx:97,
  103` and `:278-284`; `BookingModal.tsx:118-121` (`NaN` submitted as `facilityID`;
  note `ccaID: 0` is written from here on **every** booking — this client is the producer
  of the rows `deleteCcaCascade(0)` would over-match); `ManageRolesDialog.tsx:74`;
  `header.tsx:44-53`; `Calendar.tsx:20, 29`; `auth.ts:260`;
  `register/route.ts:104` (`NaN` block); `request-verification-code/route.ts:26, 34`.

### 3.2 Considered and cleared

`post.ts:28-31` (`where: { id: ctx.session.user.id }` against `Posts`) is a known,
pre-existing, wrong-domain bug, broken for everyone — cited in 08 §1.3 and included here
only as an illustration of the shape. Not a discovery.

### 3.3 Refuted — do not re-open without new evidence

- **`cascade.ts` (all four helpers).** Refuted **on reachability**: a repo-wide grep for
  `Cascade` returns **zero call sites**. Mechanically accurate, currently dead code. The
  `ccaID: 0` case is additionally already recorded at `07-cca-future.md:382-387`. Retained
  in §3.1 as latent, **not** as a finding.
- **`admin.ts`, two separate high-severity framings.** The mechanical observations were
  confirmed correct against source; the **security framing and reachability arguments were
  not**. `PendingRoleGrant` has exactly one writer in the repo.
- **`PastBookings.tsx`.** Factual core true, but the causal story that made it high — and
  made it an instance of this class — is unreachable, and one supporting claim was simply
  false.
- **An earlier `merge-accounts.mjs` framing** claiming an empty-canonical path and
  mis-attributing which derivation the script uses. The *correct* framings are §2.1 and
  §2.2 above; that specific earlier claim is refuted and should not be re-argued.

---

## 4. Damage assessment

### 4.1 Headline: by every signal in this repository, the leak code was NEVER DEPLOYED

This inverts the exercise, so it goes first.

**Window: 44m21s, entirely local, overnight.** `9cb701b` (2026-07-19 02:31:45 +0800)
→ `7a27304` (03:16:06), merged to *local* main at `6cd7fa0` (03:16:14). In UTC:
**2026-07-18T18:31:45Z .. 19:16:14Z**.

Four independent negative signals:

1. `origin/main` is still `f25b08c` (2026-07-17 14:54), the last pre-RBAC commit.
   `git rev-list --count origin/main..main` = **6** — all six commits are local-only.
2. `git branch -r --contains 9cb701b` returns **empty**. The leak commit exists as a git
   object only in this working copy.
3. `git merge-base --is-ancestor` is **NO** for both `9cb701b` and `7a27304` against
   `origin/main`.
4. The reflog shows one uninterrupted local session 01:20–03:16 with no push;
   `refs/remotes/origin/main`'s mtime is Jul 17 14:54, matching `f25b08c` exactly — it has
   not moved since the last real push.

Vercel deploys this repo from git (deployment topology: the frontend is Vercel; the
droplet runs only the Python backends). **A git-integration deploy cannot pick up a commit
that never reached GitHub.**

**Residual uncertainty, stated rather than assumed away.** A manual `vercel --prod` from
the working tree bypasses git entirely. There is **no positive evidence** of one —
`.vercel/` holds only `README.txt` and `project.json`, both untouched since Jul 13 06:39;
no `vercel` dep or script in `package.json`; no `.next/` build output. But the repo cannot
prove this negative.

> ### SUPERSEDED — this check is no longer needed
>
> This box asked for a Vercel dashboard check. **It has been answered from git instead,
> which is a stronger signal than the dashboard**: `git log origin/main..main` shows every
> commit of this work is local-only and `origin/main` remains `f25b08c` (2026-07-17).
> Vercel builds from the remote, so unpushed code cannot have been deployed by any
> mechanism. The dashboard could only have confirmed what the remote already proves.
>
> **§4.2–§4.5 are therefore contingency planning, not incident response.** No production
> damage from LEAK 1 or LEAK 2, and no disclosure question. See the head of this document.
>
> The two items that remain live are unaffected by this: §2.3 `getBooking` (deployed at
> `f25b08c`, predates this work) and §2.1 `merge-accounts.mjs` (unrun, damage entirely
> prospective).

### 4.2 The discriminator, and its one hole

Do not conflate two populations: damage *from the leak window* (needs deployment) and
*pre-existing key drift* (independent of it — `rbac-doctor.mjs --nonnus` already notes
some rows exist regardless of the branch).

Before `9cb701b`, the old derivation returned `""` **only when `token.email` was null or
empty**; for every non-NUS address it returned a truthy uppercased email. So:

> **A `Bookings` row keyed `""` is post-merge evidence — UNLESS its owner's session had a
> null/blank email.**

That hole is real, and there is a candidate for it: the blank-email `User` row that
§2.2's singleton block keys on. **Check Q3 before treating any `""`-keyed booking as proof
of the leak.**

**The forensic lever:** `Bookings` (`schema.prisma:101-118`) has **no `createdAt`** — but
`_id` is an ObjectId whose leading 4 bytes are the creation unix time, so creation can be
window-scoped exactly:

```
lo = ObjectId("6a5bc6910000000000000000")   // 2026-07-18T18:31:45Z
hi = ObjectId("6a5bd0feffffffffffffffff")   // 2026-07-18T19:16:14Z
```

### 4.3 Which query produces which figure

**No figure below has been measured.** Extend `rbac-doctor.mjs` rather than running loose
snippets — it is already read-only, already refuses `--commit`/`APPLY=yes` (`:258`), and its
`--nonnus` section [3] (`:344`) already `$group`s `Bookings` by `userID`. Add a
**`--forensics`** flag (keep `--nonnus`'s output stable), reusing `raw()`, `aggregateAll()`,
`bucketOf()`, `keyLabel()`, `sample()` and — importantly — the `unreadable[]` accumulator,
which distinguishes *a failed command* from *a measured zero*. Preserve that discipline.

| Figure needed | Query |
|---|---|
| `""`-keyed `Bookings`, bucketed before/during/after the window by `_id` | **Q1** `$group` on `userID` with `$cond` on the ObjectId bounds. *Converts an ambiguous count into an attribution — the single highest-value addition.* |
| Blast radius: what the `""` pool contained | **Q2** `find({userID:""})` projecting `bookingID`, `facilityID`, `startTime`, `eventName`. Every row was visible as "My Bookings" to **every** empty-identity user simultaneously — one undifferentiated pool, not pairwise collisions. |
| Discriminator hole (§4.2) | **Q3** `countDocuments({$or:[{email:null},{email:""}]})` on `User`. Non-zero ⇒ Q1's rows are not unambiguously attributable to the leak. |
| Did the RBAC branch ever touch this DB at all | **Q4** `countDocuments({})` across `RoleAuditLog`, `UserRole`, `PendingRoleGrant`, `SystemFlag`, `CcaHead`, `BulkRoleImport`. |
| Forged/blank audit actors | **Q5** `RoleAuditLog` on `actorUserID` ∈ {`""`,`"(anon)"`} or matching `@`, plus a window scan on `at`. |
| §2.1/§2.2/§2.4 preconditions — **run before anyone runs the script** | **Q6** `UserMatric.find({userID:""})`; `User.countDocuments({email:"", userID:/^A\d{7}[A-Z]$/})`; non-NUS duplicate-email groups. |
| §2.7 whitespace duplicates | **Q7** `User.find({$or:[{email:/^\s/},{email:/\s$/}]})`. |

### 4.4 What the data would show per finding

| Finding | Signature | Detectable? | Recoverable? |
|---|---|---|---|
| Leak 1 (own-bookings over-match) | No write. Only *secondary* writes leave traces. | **Indirectly.** Q1/Q2 find the pool. A leak-driven **deletion** leaves nothing. | Reads: nothing to recover. Wrongly-deleted rows: **unrecoverable** absent a point-in-time backup covering the window. |
| Leak 2 (`userTeleHandle`) | **None whatsoever.** A read. | **NO** — §4.5. | N/A |
| `deleteBooking`/`updateBooking` false ownership | A `""`-keyed row deleted or mutated by a non-owner. | **Barely.** `_id` gives *creation*, not modification; Mongo tracks no mtime and `Bookings` has no `updatedAt`. In-place edits are invisible. | **Unrecoverable** without a backup. |
| `actorUserID: userID ?? "(anon)"` | `RoleAuditLog` row with `actorUserID: ""` — a blank actor in an append-only log. | **YES, cleanly (Q5).** The one durable, unambiguous artifact, because the log is append-only and `""` is a value no fixed path can now write. | Rows persist; cannot be re-attributed, but **can** be identified and annotated. |
| §2.1/§2.2 `merge-accounts.mjs` | `User.userID` and dependents keyed on an uppercased email. | **YES (Q6), prospectively.** | **Has not run. Damage entirely future — and this is the one item whose recoverability window is still open.** It closes the moment someone runs it, because the backup captures no dependent-row keys. |
| §2.4 `getMatricStatus` | Needs a `""`-keyed `UserMatric` row. | **YES (Q6).** | Currently inert. |
| §2.3 `getBooking` | Handle disclosure via an untouched route. | **NO — no trace.** | N/A. **Note this one is still live in current code.** |
| §2.7 whitespace duplicate | Two `User` rows, same `userID`. | **YES (Q7).** | Recoverable — but **do not let `dedupe-users.mjs` run first**; its collation folds case, not whitespace. |

### 4.5 What cannot be measured after the fact — stated plainly

**A disclosed Telegram handle leaves no trace in any database. None — not partial, not
reconstructable-with-effort.**

Specifically unmeasurable, permanently:

- **Who saw whose Telegram handle** (leak 2, and the still-open `getBooking` route). The
  disclosure happened in an HTTP response body. There is no read log, no access log in the
  schema, no per-request audit. Victims cannot be enumerated, viewers cannot be enumerated,
  the count cannot be bounded.
- **Who saw whose bookings** (leak 1). Same reason.
- **Whether the leak was exercised at all**, versus viewed by zero people. No telemetry.
- **Modifications** — no `updatedAt`, so an in-place overwrite during the window is
  indistinguishable from the original.
- **Deletions** — no soft-delete, no tombstones. A wrongly-deleted booking is simply absent.

The only external sources that could bound any of this are **Vercel and Atlas request
logs**, outside this repo and subject to retention. **If deployment is in question at all,
pull them immediately — retention is the only clock actually running.**

> **Consequence for reasoning: you can never prove nobody was harmed by the disclosure.
> You can only prove the code was never reachable.** That is why §4.1 is load-bearing, and
> why the dashboard check outranks everything else here — the data will never answer it.

### 4.6 The disclosure question — surfaced, not decided

**Deliberately not decided here.**

*If deployment is confirmed negative (expected):* there is **no disclosure question**. No
user data was exposed because no user could reach the code. Any `""`-keyed rows Q1 surfaces
are pre-existing key drift — a data-hygiene matter, not an incident.

*If a deployment during the window is found:* a personal-data disclosure to unidentifiable
parties. **Toward disclosure:** Telegram handles are directly identifying contact
information (personal data under the PDPA; RH's users are a real, identifiable student
community); the affected cohort is structurally enumerable from `User` even though the
viewers are not; and per §4.5 the harm **cannot be bounded downward** — "probably nobody
looked" is an assumption that will never become a finding. **Mitigating:** 44 minutes,
02:31–03:16 local, near-minimum plausible traffic for a student residence app; exposure
required an affected user to actively open the bookings view in that window; data was
limited to handle, bio, block and userID — **no credentials, no `passwordHash`, no payment
data**; fixed within an hour.

**The honest framing:** the decision turns almost entirely on the deployment question and
hardly at all on the data, because the data cannot answer it. Resolve §4.1 first. If it
comes back clean this section is moot. If it does not, the unmeasurability is itself a fact
a decision-maker needs to weigh — which argues for consulting whoever owns RH's
data-protection posture rather than settling it engineer-to-engineer.

---

## 5. Prevention

### 5.1 The measured surface

Established by grep, not estimated:

| Fact | Value |
|---|---|
| **Server-side `session.user.userID` reads** | **34** — `admin.ts` 20, `facilitiesBooking.ts` 6, `user.ts` 4, admin layouts 3, `auth.ts` 1 |
| `userID` mentions in `src/` | 272 across 25 files |
| `where:` sites in `src/` | 52 |
| Existing `if (!userID)` / `Boolean(userID)` guards | 14 |
| ESLint | 8.57, **legacy `.eslintrc.cjs`** (not flat), `parserOptions.project: true` already on |
| Test framework | **none** |
| `userIDSchema` (zod, `min(1)` + E-format) | **already exists** (`admin.ts:67`), used at 11 input sites |
| Remediation scripts | `.mjs` — **outside `tsc` entirely** |

Two facts reframe the question. **(A) The threading surface is small** — 34 sites, not 272,
and 20 of those are one line in `admin.ts` procedures that a middleware collapses to zero.
**(B) The prevention mechanism for the `[high]` findings already exists and is mis-scoped**:
`verify-identity-parity.mjs` is a DB-free, network-free, CI-safe gate that executes
`src/lib/identity.ts` against `scripts/remediation/lib/identity.mjs` over a longhand fixture
list. It is well built. **It checks one file pair** — while `merge-accounts.mjs:84` defines a
*private* derivation claiming to mirror `auth.ts`, and nothing re-checks that claim.

So §2.1 and §2.2 are not "someone forgot a guard". They are **one file declining to import
the shared module**, in a repo that has both a shared module and a gate for it.

### 5.2 The recommendation

**Type the absent case out of the string domain, and make the compiler the sweep.**

```ts
// src/lib/identity.ts
export type CanonicalUserID = string & { readonly __brand: "CanonicalUserID" };
export function canonicalUserID(email: string|null|undefined): CanonicalUserID | null
```

with `auth.ts:96` changing `userID: string` → `userID: CanonicalUserID | null`, and one
middleware in `trpc.ts` narrowing once:

```ts
export const identifiedProcedure = protectedProcedure.use(({ ctx, next }) => {
  const userID = ctx.session.user.userID;
  if (userID === null) throw new TRPCError({ code: "FORBIDDEN", message: "NO_CANONICAL_IDENTITY" });
  return next({ ctx: { ...ctx, userID } });   // typed CanonicalUserID, non-null
});
```

**Why this and not more guards.** Every `Boolean(k) &&` in `7a27304` is correct, and every
one is a **per-site** defence against a **global** invariant. Thirteen shapes across four
routers, three services and the client cannot be held by guard discipline over time — the
next `9cb701b`-equivalent re-arms all of them at once.

**Why `null` is the whole trick.** Per §0.2, TypeScript cannot see `""` — but it can see
`null`. Runtime behaviour is **unchanged** (both are falsy; all 14 existing guards keep
working), while:

- `where: { userID }` → **compile error** (`null` is not assignable to `string | StringFilter`) — kills **S1 and S2**
- `booking.userID === callerUserID` → compile error under `strictNullChecks` — kills **S3, S4**
- `dict[userID]` → compile error (`null` is not a valid index type) — kills **S5**
- `userID ?? "(anon)"` → **now actually fires**, because `null` *is* nullish — kills **S7 by construction**; the fallback that was written correctly starts working

**Honest caveat:** `` `${prefix}:${userID}` `` still compiles and is still wrong
(`"rl:null"`). **S13 survives** and needs the runtime assertion. Branding also does not
reach the `.mjs` scripts — i.e. **neither `[high]` finding** — which is why §6 sequences the
script gate *first*. Nor does it reach the `Int` sentinels (`ccaID: 0`) unless separately
branded, nor Problem B.

Cost: ~34 compile errors, realistically **half a day**, all mechanical, all caught by the
compiler. Boundary ergonomics are fine — brands erase at runtime, `userIDSchema` gets a
`.transform(s => s as CanonicalUserID)`, and the session type is a one-line augmentation.
`tsc --noEmit` — already a permitted command here — **becomes the sweep, permanently. The
errors *are* the sweep.**

### 5.3 On the session: type the field `null`; do NOT refuse the session

**Refusing the session is not a safety change — it is a product change wearing safety
clothing.** Today `auth.ts:302-311` sets `userID = ""` and `eligible = true` at the default
`"off"`. If the callback threw or returned null for an empty canonical, **every non-NUS
account is locked out at the door, immediately, on deploy, with no flag flip able to restore
it** — only a redeploy. That is *identical in effect to flipping `rbac.auth.enforcement` to
`enforce`*, the deliberate, staged, reversible decision the kill switch exists to defer. It
also breaks the 30-day live-JWT cohort with no warning path. **Hard-coding it into the
session callback destroys the switch** — see 08 §5's standing instruction not to flip early.

`null` gets the structural guarantee with none of the blast radius.

It also **surfaces one genuine design decision rather than creating it**: §2.5's two
definitions of "eligible". Typing the field `null` forces `MatricGate` to handle the case
explicitly. It will not decide *which* definition is right — but it makes shipping the
ambiguity impossible.

### 5.4 Rejected, with reasons

| Option | Verdict |
|---|---|
| **Branding alone** (`string & {__brand}`, no `null`) | **Insufficient.** Still admits `"" as CanonicalUserID` at the mint site, and every downstream `===`, `where:` and dict key behaves identically. The brand prevents *re-widening*; it does not prevent *emptiness*. Only the `\| null` does the work. |
| **Zod refinement on inputs** | **Already done, and it misses the class.** `userIDSchema` is sound at 11 sites — keep it. But **every confirmed leak came from a server-derived identity zod never sees.** Adding refinements creates the appearance of coverage without the substance. *One real gap it exposes:* §2.6's client guard is stricter than this schema and fails open on the difference — export `userIDSchema` to the client so there is one predicate, not two. |
| **Custom ESLint rule** | **Do not bother.** (1) Subsumed — if §5.2 ships, `tsc` reports exactly this class with perfect precision. (2) Not implementable at usable precision: the real predicate is *guard dominance*, which needs CFG reachability ESLint does not offer; any approximation false-positives on guards inside a callee — **including `access.ts:241`, the very site §1 holds up as the model.** (3) ESLint 8 + legacy `.eslintrc.cjs` makes a local plugin awkward. A rule that fires on the model site is `eslint-disable`d within a week, which is worse than not having it. |
| **Standalone `assertIdentity()` helper** | **Yes, but as part of §5.2, not instead of it.** Standalone, it has the exact failure mode that produced these bugs: **you must remember to call it.** As the body of `identifiedProcedure` it is called *structurally* — you get it by choosing a procedure builder, a decision you are already making. |
| **Test framework + per-router isolation tests** | **Defer.** Ask what would have caught `9cb701b`: not a router test, but a **contract test on `canonicalUserID` itself** — and `verify-identity-parity.mjs` **already is that test**. So the thing to buy is widening the gate that exists, not a framework. Priced anyway: vitest + `vitest-mock-extended`, ~0.5 day. Its real value is regression-locking `7a27304`, which is genuine but second-order — writing such a test requires the same insight as writing the guard, so it adds little independent coverage against the *next* unforeseen revocation. **Skip `mongodb-memory-server` entirely**; these are query-shape bugs, and a mock asserting the emitted `where` object catches them for a fraction of the cost. |
| **A review checklist** | **Fallback only, one line, one place** — a comment block in `scripts/remediation/README.md`, because `.mjs` is the one surface no type system or lint rule reaches and it holds the highest-severity finding. Not as a general review practice; nobody reads those. |

### 5.5 Bonus finding: the runbook documents the pre-merge derivation

`scripts/remediation/README.md:76` documents the merge canonicalization as
`email.toUpperCase().replace("@U.NUS.EDU","")` — **the pre-`9cb701b` derivation.** An
operator reading the README to sanity-check `merge-accounts.mjs` before an `APPLY=yes` run
finds the script and the doc in perfect agreement, and both wrong. **The doc is part of the
failure.** Any fix to §2.1 must update line 76, or the next reviewer re-derives the same
false confidence.

---

## 6. Sequencing

| | Step | Depends on | Effort | Reversible |
|---|---|---|---|---|
| ~~P0~~ | ~~Vercel dashboard check~~ — **DONE, from git**: `origin/main` is `f25b08c`, all of this work is unpushed, so it was never built. §4.1 | — | done | n/a |
| **P0** | §2.3 `getBooking` ownership check — **the only finding live in production.** See `10-remediation.md` C1 | nothing | ~1h | yes |
| **P0** | **Freeze `merge-accounts.mjs`.** Do not run it under `APPLY=yes` until §2.1+§2.2 are fixed and Q6 has been read | nothing | zero | n/a |
| **P0** | Run Q6 **before** anyone runs that script — the only *future* damage in the set, and the only still-open recoverability window | freeze | minutes | read-only |
| **P1** | **Extend `verify-identity-parity.mjs` into a private-derivation ban**; fix `merge-accounts.mjs:84` to import the shared `canonicalUserID`; adopt `rekey-canonical.mjs:74-83`'s abort-on-empty-target; update `README.md:76` | nothing | ~1h | yes |
| **P1** | §2.3 `getBooking` ownership check — **live disclosure, defeats the shipped fix** | nothing | ~1h | yes |
| **P1** | §2.5 `MatricGate` empty-identity branch + 08 §1.1's write hoist (S8 — **caps the cohort**) | nothing | ~2h | yes |
| **P2** | §5.2 `CanonicalUserID \| null` + `identifiedProcedure`; verify with `tsc --noEmit` | P1 | ~0.5d | yes |
| **P2** | §2.6 + export `userIDSchema` to the client (one predicate, not two) | §5.2 | ~1h | yes |
| **P2** | §2.8's four admin surfaces — copy `profile/page.tsx:87-103` | nothing | ~2h | yes |
| **P2** | §2.7 whitespace-email normalization at `/api/register` — **before `dedupe-users.mjs` runs** | nothing | ~1h | yes |
| **P3** | §2.4 `getMatricStatus` guard; §3.1's live `userDict` collapse; the rest of §3.1 as tickets | measurement | — | yes |
| **P3** | Defer: vitest + isolation tests. Do not build: the ESLint rule | §5.2 landed | — | — |

**Ordering rationale.** Writes before reads (§1.1): the P1 write-hoist caps the orphan
cohort permanently, while read fixes only cap today's exposure. The script gate precedes the
type work because **no type system reaches `.mjs`**, where both `[high]` findings live.

**Interaction with 08 §5:** none of this changes 08's standing instruction — **do not flip
`rbac.auth.enforcement` to `enforce`** before 08 §2 measures and §3 resolves. §5.3 exists
precisely because one tempting "fix" here would flip it by accident.

---

## Done when

- [x] **Deployment question settled** (2026-07-19, from git): `origin/main` is `f25b08c`
      and all of this work is unpushed, so LEAK 1 and LEAK 2 never shipped. No disclosure
      question. Supersedes the Vercel-dashboard check this document originally called for.
- [ ] `merge-accounts.mjs` imports the shared `canonicalUserID`, aborts on an empty target
      key, and **no private identity derivation exists** anywhere under `scripts/` or `src/`
      except the one allowlisted `legacyCanonicalUserID` (`lib/rbac.mjs:164`).
- [ ] `verify-identity-parity.mjs` **fails** on a reintroduced private derivation — proven
      by deliberately reintroducing one once.
- [ ] `README.md:76` documents the *current* derivation.
- [ ] Q6 has been run and its result recorded **before** any `APPLY=yes` run.
- [ ] `getBooking` applies an ownership check, or its disclosure is justified in writing.
- [ ] `MatricGate` handles `userID === ""` explicitly, and `MatricGate` and
      `getCurrentUserData` **agree on one definition of "eligible"**.
- [ ] No session with `userID === ""`/`null` can write a `Bookings` row in any mode
      (08 §1.1 — restated because it is this class's generator).
- [ ] `canonicalUserID` returns `CanonicalUserID | null`; the session field is typed the
      same; `tsc --noEmit` is **clean**, and the errors it raised on the way were reviewed
      as a sweep rather than silenced.
- [ ] The session is **not** refused for an empty canonical (§5.3), and the auth kill switch
      still works.
- [ ] Every §2.8 surface distinguishes "could not load" from "there is nothing", and no
      safety warning derives from an array that is empty on failure.
- [ ] `""`-keyed `Bookings` rows: **counted via Q1 and attributed** before/during/after the
      window, with Q3 run to check the discriminator hole. Figure and date recorded.
- [ ] The `RoleAuditLog` blank-actor census (Q5) is recorded — the one durable artifact.
- [ ] Every §3.1 item is either promoted to a finding **with a reproduction**, or closed with
      a reason. None are left in limbo.
- [ ] §3.3's refuted items are **not** re-argued without new evidence.
