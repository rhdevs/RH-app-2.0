# 10 — Remediation: the commit plan for 09

> **Status:** plan. **Supersedes [`09-empty-identity-class.md`](./09-empty-identity-class.md) §6
> and its "Done when".** 09 stays authoritative for *analysis* — the class (§0), the
> shapes (§1.1), the findings (§2), the non-findings (§3), the unmeasurables (§4.5)
> and the prevention argument (§5). This document does not restate any of it. It
> converts §2.1–§2.8 into implementable commits, resolves the three decisions that
> block them, and replaces 09's sequencing table.
>
> **No production data has been measured for this document either.** Where a number
> is needed, 09 §4.3's query id (Q1–Q7) is named instead. Do not let a figure enter
> this file un-named.
>
> Read 09 first. Read [`08-userid-keydrift.md`](./08-userid-keydrift.md) for the
> incident.

---

## 0. The organizing principle: exposure, not severity

09 §2 ranks by blast radius. That was the right frame for *finding*; it is the wrong
frame for *shipping*, because it puts `[HIGH]` script findings ahead of a `[MEDIUM]`
that is serving user data to strangers right now. Rank by **where the damage is in
time**:

| Tier | Meaning | Members | What ordering buys |
|---|---|---|---|
| **T0 — LIVE** | present at `origin/main` = `f25b08c`, deployed today | §2.3 `getBooking` | Every hour it is unfixed is exposure that has already accrued and **cannot be measured afterwards** (09 §4.5). |
| **T1 — FUTURE, preventable** | an unrun one-way write | §2.1, §2.2 | The only still-open recoverability window in the whole set. It closes the instant someone types `APPLY=yes`. |
| **T2 — LOCAL, never shipped** | introduced by the 7 unpushed commits; damage to date is **zero** | §2.5, §2.6, §2.7, §2.8, §3.1's live `userDict` | These are not incidents. They are **push blockers**. Fixing them before the push means they never become T0. |
| **T3 — structural** | prevents the next instance | §5.2 branded type, §5.4's parity widening | Buys nothing today; buys everything on the next `9cb701b`. |

**Consequences that drive the whole plan:**

1. **T0 ships first and alone.** One file, one procedure, revertible in seconds.
2. **T1 needs no code to be safe today** — it needs the script *not run*. The freeze
   is free and immediate; the code fix is a P1 that removes the need for discipline.
3. **T2 has no clock on it at all.** Nothing in T2 is exposed to a user until the
   push. This is the one piece of good news in 09 and it should be spent: T2 work
   can be reviewed properly rather than hot-fixed.
4. **Never push a T2 fix's *dependency* without the fix.** The push is atomic in
   effect even if the commits are not — see §4.

09's `[HIGH]`/`[MEDIUM]`/`[LOW]` labels are retained below for cross-reference only.
They do not set order here.

---

## 1. Decisions — resolve these, they block commits

Three items in 09 are stated as open. Each has a recommendation, a cost if the owner
disagrees, and a named blocking commit. **Nothing here waits on a decision to
start**; each has a default that is safe to implement now and cheap to reverse.

### D-A — what does `getBooking` return to a non-owner? (09 §2.3) — blocks **C1**

**RECOMMENDATION: full ownership check. `NOT_FOUND` for a non-owner, admin bypass,
same shape as `deleteBooking` (`facilitiesBooking.ts:492-499`).**

Three arguments, in ascending order of force:

1. **The codebase's revealed intent.** `getBookings` already gates `userTeleHandle`
   on ownership (`facilitiesBooking.ts:320-323`, shipped in `7a27304` as `#10`
   "stop broadcasting Telegram handles"). A handle is not public *in this
   codebase's own judgement*, decided deliberately, in this file, this week. A
   route that serves the same field unguarded is not a second opinion — it is the
   first decision with a hole in it.
2. **The calendar does not need it.** The booking UI's display need is
   `displayName`, `eventName`, `facilityName`, times — every one of which
   `getBookings` already returns, with the handle withheld. There is no
   legitimate display requirement for a stranger's `telegramHandle` or `bio`
   that `getBookings` is not already meeting.
3. **`getBooking` has zero callers.** `grep -rn "getBooking" src/ | grep -v getBookings`
   returns exactly one line: the definition at `facilitiesBooking.ts:141`. No page,
   no component, no hook. **The regression surface of gating it is empty.** This is
   the decisive fact and 09 does not record it.

**Why not delete it, given (3)?** Deletion is the stronger fix and is defensible,
but it asserts a negative about consumers outside this repo that the repo cannot
prove — and reverting a deletion under pressure is a bigger change than reverting a
guard. Gate it now; delete it in a later cleanup if it is still callerless.

**If the owner disagrees** — i.e. decides hall residents seeing each other's contact
details *is* intended — then the acceptable form is **not** "leave it". It is:
narrow the non-owner projection to `{ userID, displayName, block }` and drop
`telegramHandle` and `bio`, and **record the decision in this file with a date**,
because 09's "Done when" will otherwise re-raise it forever. And note the
consequence: `getBookings`' §2.3 gate then becomes incoherent and should be relaxed
to match, or the two routes disagree about the same field again.

**Do not choose "leave it".** It is the only option that leaves a live disclosure
open with no owner and no record.

### D-B — approve the `CanonicalUserID | null` refactor? (09 §5.2) — blocks **C9**

**RECOMMENDATION: yes. Approve it, schedule it after T0–T2, do not let it block them.**

The case, honestly stated on both sides:

- **What it buys.** 09 §0.2's central claim is that the type system is *actively
  reassuring* about this class. Typing absence as `null` inverts that: `where: { userID }`,
  `booking.userID === callerUserID`, `dict[userID]` and `userID ?? "(anon)"` stop
  compiling or start behaving. S1, S2, S3, S4, S5 and S7 become compile errors — six
  of thirteen shapes, including both leak shapes, **permanently and without
  discipline**. `tsc --noEmit` is already a standing permitted command here, so the
  sweep becomes free and repeatable.
- **What it costs.** ~34 threading sites (09 §5.1), ~0.5 day, all mechanical. The
  real cost is not the errors — it is that 34 diffs across `admin.ts`,
  `facilitiesBooking.ts`, `user.ts`, `auth.ts` and the admin layouts land in a repo
  with **no test framework** (09 §5.1), on the booking path, immediately before or
  after a push that is already carrying seven commits of unreviewed RBAC work. That
  is the argument for sequencing it last, not for skipping it.
- **What it does NOT buy — preserve this reasoning.** Both `[HIGH]` findings (§2.1,
  §2.2) live in `merge-accounts.mjs`, which is `.mjs` and therefore **outside `tsc`
  entirely**. No branded type, no `strictNullChecks`, no compiler pass reaches them —
  ever. The mechanism that covers `.mjs` is the parity gate widened into a
  private-derivation ban (**C3**), and it is the *only* mechanism that does. This is
  why C3 is sequenced ahead of C9 and why C9 cannot be described as "the fix for
  09". It fixes `src/`. C3 fixes `scripts/`.
- **The cheaper fallback**, if 0.5 day is refused: `identifiedProcedure` alone
  (09 §5.2's middleware, `throw FORBIDDEN` on empty, `next({ ctx: { userID } })`),
  applied to the procedures that need an identity, with `userID` still typed
  `string`. **Buys:** structural narrowing at the boundary, obtained by choosing a
  procedure builder rather than by remembering a call — 09 §5.4's argument for why
  the middleware beats a standalone `assertIdentity()`. **Misses:** everything the
  compiler was going to do. Every site that does not adopt the new builder stays
  invisible, and the *next* revocation re-arms them all at once, silently, exactly
  as `9cb701b` did. The fallback is a guard; the refactor is a proof.

**If the owner disagrees:** ship the fallback, and add a line to
`scripts/remediation/README.md` recording that the class is held by convention
rather than by the compiler — because the next person will otherwise read
`identifiedProcedure` as evidence the class is closed.

### D-C — one definition of "eligible" (09 §2.5) — blocks **C5**

The disagreement is real and visible to one user at one moment: `/profile` renders
the ineligible panel (`user.ts:90-97`, `eligible: false` derived from `!userID`)
while `MatricGate.tsx:50` reads `session.user.eligible` — which `auth.ts:310-311`
sets `true` whenever the kill switch is not `enforce`. Same word, two predicates,
same session.

**RECOMMENDATION: stop overloading the word. Two concepts, two names.**

- **`eligible`** keeps `auth.ts:310`'s meaning exactly: *"the D-7 enforcement
  decision — is this principal admitted under the current
  `rbac.auth.enforcement` mode."* It is flag-aware by design (I-11), it is
  `protectedProcedure`'s backstop (`trpc.ts:138`), and **it must not change**.
  Changing it is 09 §5.3's trap: it is the kill switch, wearing a different name.
- **`hasIdentity` = `userID !== ""`** is added to the session (one boolean, derived
  in the same callback, no query) and is what every *render-layer* branch keys off.
  `MatricGate` redirects to `/onboarding/ineligible` on `!hasIdentity`;
  `getCurrentUserData`'s early return at `user.ts:90` returns `hasIdentity: false`
  and `/profile` branches on that.

**Why this and not "make `MatricGate` read `userID === ""`" directly** (08 §1.2's
instruction): that is the same fix, and it is fine — but it leaves `eligible`
carrying two meanings in the reader's head, which is the condition that produced the
bug. Naming the second concept is the part that does not decay. It is also exactly
what 09 §5.3 predicts the type change will *surface but cannot decide*: this is the
decision, made.

**Product consequence, stated so it is chosen and not inherited:** an
empty-identity user is redirected to `/onboarding/ineligible` **in every mode,
including the shipping default `off`**. Today they get the full app. That is a
visible behaviour change for the non-NUS cohort on deploy — whose size is
**unmeasured; run 09 §4.3 Q3 and the doctor's `--nonnus` list before shipping C5**.
It is *not* a lockout: they retain their session, `/onboarding/ineligible` explains
the state and offers sign-out, and no flag flip is involved. It is strictly gentler
than flipping `rbac.auth.enforcement` to `enforce`, which 08 §5 still forbids.

**If the owner disagrees** and wants the default-`off` cohort to keep full app
access: then `MatricGate` must still stop rendering the *booking* affordance for
`!hasIdentity` and say why, because `evaluateBookingWithMode` now denies that write
(see §2 below) and the alternative is a button that always errors. A gate that
redirects is cheaper to build and cheaper to explain than a partial one.

---

## 2. What 09 got wrong or stale — corrections carried into this plan

Found while reading 09 against source. Each is corrected here rather than in 09, so
09 stays a record of what was believed at the time.

**(a) 09 §6's first two P0 rows are obsolete, and 09 contradicts itself.** The head
block (09:19-37) settles the deployment question from git and says it "needs no
further check". §4.1's box and §6's first two rows still call the Vercel dashboard
check "the highest-priority action in this document", and the "Done when" list still
opens with it. **The head block is right and the rest is stale.** `origin/main` is
`f25b08cd8679948567fc7ce6030e61a3e453c6dd`; `git rev-list --count origin/main..HEAD`
is **7** (09 says 6 — the count moved when 09 itself was committed as `d5cdf57`);
Vercel deploys from the remote. LEAK 1 and LEAK 2 were never built and never served.
**There is no disclosure question from them, and no dashboard row in this document's
P0.** 09 §4.6's contingency branch is retained as contingency and nothing more.

**(b) 09's head block cites the wrong section for its own headline.** It says "This
does NOT clear §2.2 (`getBooking`)". `getBooking` is **§2.3**; §2.2 is the
`""`-keyed `UserMatric` seed. The *substance* is correct and confirmed against
source: `publicUserSelect` including `telegramHandle` is present at `f25b08c`
(`git show f25b08c:src/server/api/routers/facilitiesBooking.ts`, `publicUserSelect`
at :12-19, `getBooking` at :75-103, no ownership check), so it is live now and
predates all of this work.

**(c) 09 §2.5's reproduction is stale at step 3 — the write hazard is already
closed.** §2.5 step 3 asserts "`evaluateBookingWithMode` at `off` allows … and
`:448-461` writes `Bookings.userID: ""` — this is S8, the generator." **False
against current source.** `7a27304` already shipped 08 §1.1 in full:
`access.ts:414-424`'s `if (!userID)` now sits **above** the mode branch with the
comment "*there is no mode in which an unownable booking row is the correct
outcome*"; the reason code is `NO_IDENTITY`, distinct from `NOT_RESIDENT`; and the
audit write uses `actorUserID: "(anon)"` (`:444`) and `userID || "(anon)"` (`:489`),
not `?? `. Consequently:

- **09 §6's P1 row "§2.5 MatricGate … + 08 §1.1's write hoist" is half-done.** Only
  the `MatricGate` half remains. The estimate drops accordingly.
- **The `""` cohort is already capped.** No new `""`-keyed `Bookings` row can be
  written by any session in any mode. 09 §1.1's "sweep writes before reads" is
  satisfied for the booking path — which is why T2 in §0 has no clock on it.
- **§2.5's remaining harm is narrower than 09 states**: not an uncancellable locked
  slot, but an ungated app for a cohort whose every booking attempt now fails with
  `NO_IDENTITY` and no explanation before the click. That is still worth C5. It is
  a UX and coherence bug, not a generator.
- 09's "Done when" row "No session with `userID === ""`/`null` can write a
  `Bookings` row in any mode" is **already satisfied by inspection** and is
  restated below as a *regression check*, not as open work.

**(d) §2.7 is not live either — it is a regression the unpushed work introduces.**
09 §2.7 reads as a standing bug. At `f25b08c`, `register/route.ts:51` gates on
`email.endsWith("@u.nus.edu")`, and `" e1234567@u.nus.edu "` does **not** end with
that literal, so the whitespace form is rejected today. It becomes reachable only
because `isNusStudentEmail` → `normalizeEmail` adds the load-bearing `.trim()`
(`identity.ts:41-42`) while the duplicate probe (`register/route.ts:77-84`) still
folds only case. **So §2.7 belongs in T2 — a push blocker — not in the live set.**
This strengthens 09's own conclusion (fix it before `dedupe-users.mjs` runs) and
changes its urgency: it must not be pushed, but it is harming nobody.

**(e) Minor citation drift, corrected in the commits below.** 09 (and
`access.ts:419`'s comment) cite the `userDict` join as
`facilitiesBooking.ts:215-230`; it is now `:229-242`, consumed at `:310`. 09 §3.1
has the right numbers. Fix the `access.ts` comment while in C6 — a stale line
reference in a load-bearing comment is how 08 §0.2's `:146` comment misled people.

**(f) Everything else in §2 verified as written.** `publicUserSelect`
`facilitiesBooking.ts:22-29`; `getBooking` `:141-176`; `getMatricStatus` unguarded
at `user.ts:166-173` between two guarded siblings at `:90` and `:194`; `MatricGate`
`eligible === false` at `:50`; `AuditLogTable` regex ternaries at `:99-100` and the
`EmptyState` at `:206-212`; `merge-accounts.mjs`'s `deriveCanonical` docstring and
body at `:83-85`; `README.md`'s "mirrors `src/server/auth.ts` exactly:
`canonical = email.toUpperCase().replace("@U.NUS.EDU","")`". No further correction.

---

## 3. The commits

Nine commits, each independently shippable, reviewable and revertible. Subject lines
are proposed verbatim. PR grouping and standalone requirements are stated per commit.

Every commit's **Regression surface** section is written for a reviewer of *this*
repo: ~515 people book rooms daily, there is no test framework, and the booking path
is the highest-risk surface in the codebase. "What must NOT change" is the load-
bearing half.

---

### C1 — `getBooking` ownership check  ·  T0 · §2.3 · **MUST STAND ALONE**

> `Gate getBooking on ownership — it served any booking to any signed-in user`

**This is the only commit in this document that fixes something a real user can
reach today. It ships first, by itself, on its own PR, and it does not wait for
D-B, C9, or the push of the RBAC branch.**

**File / function:** `src/server/api/routers/facilitiesBooking.ts`, `getBooking`
(`:141-176`).

**Change.** After the `!booking` `NOT_FOUND` throw at `:148`, before the
`Promise.all` at `:150`, apply the ownership predicate already used by
`deleteBooking` (`:492-499`) — the same shape, deliberately, so there is one
ownership idiom in this file and not two:

```ts
// 09 §2.3: this route had NO ownership check and joined publicUserSelect
// (telegramHandle, bio, block) for an arbitrary bookingID from a bare
// z.number(). Iterating the sequential id space handed every owner's Telegram
// handle to any signed-in user — the payload #10 removed from getBookings
// (:320-323), reachable by a route that fix did not touch.
//
// Boolean(callerUserID) is load-bearing for the same reason it is at :493:
// "" === "" is a FALSE MATCH against any ""-keyed row. An empty id owns nothing.
// NOT_FOUND, not FORBIDDEN: a 403 confirms the id exists and turns the id space
// into an enumeration oracle for how many bookings the hall has.
const callerUserID = ctx.session.user.userID;
const owns = Boolean(callerUserID) && booking.userID === callerUserID;
if (!owns && !(await isAdmin(ctx.db, callerUserID))) {
  throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });
}
```

`isAdmin` and `TRPCError` are already imported (`:3`, `:12`).

Also correct the stale comment at `:152-159` per 08 §0.2 if not already done — it is
accurate in the current tree; leave it.

**Depends on:** D-A only. Implement the recommendation; if the owner later picks the
fallback, the change is a two-line edit to a projection.

**Regression surface — what must NOT change:**

- **`getBookings` (`:179-327`) is untouched.** It is the calendar's data source and
  the highest-traffic query in the app. Do not "unify" the two routes in this commit.
- **`publicUserSelect` (`:22-29`) is untouched.** It is shared; narrowing it here
  would silently change `getBooking`'s facility/CCA joins and anything added later.
  D-A's fallback would narrow it *per call site*, never at the constant.
- **The admin arm must survive.** An `admin`/`jcrc` opening a booking they do not own
  must still get the full record. `isAdmin` reads membership over the whole role set
  (`:200-202`'s I-6 note) — do not reintroduce a positional `roles[0]` read.
- **The `NOT_FOUND` message must be byte-identical to the existing one at `:148`.**
  Different text for "absent" and "not yours" is the same enumeration oracle the
  status code was chosen to avoid.

**Reviewer checks:** (1) the guard is *after* the `!booking` throw, so a genuinely
missing booking is still `NOT_FOUND`; (2) `Boolean(callerUserID) &&` is present —
without it an empty-identity session matches every `""`-keyed row, which is 09 §2.3's
second, in-class arm; (3) `getBookings` diff is empty.

**Verify:** `npx tsc --noEmit` and `npm run lint` clean. Behavioural verification
needs a running app and a database, both forbidden here — so it is stated as a
manual acceptance step for whoever runs it: sign in as a non-owner, call
`bookings.getBooking` with another user's `bookingID`, expect `NOT_FOUND`; repeat as
the owner and as an admin, expect the full record. **No production data figure is
asserted; nothing about how many times this was exercised is knowable (09 §4.5).**

---

### C2 — `merge-accounts.mjs`: import the shared derivation, abort on an empty target  ·  T1 · §2.1 + §2.2 + §5.5

> `merge-accounts: use the shared canonicalUserID and refuse an empty target key`

**Before this lands, the operational control is the freeze (§4). The freeze is what
protects the data; this commit is what removes the need for someone to remember it.**

**Files:** `scripts/remediation/merge-accounts.mjs`, `scripts/remediation/README.md`.

**Change, four parts:**

1. **Delete the private derivation at `:83-85`** and import the shared one. The
   docstring's claim — *"EXACT mirror of the auth.ts session-callback derivation,
   quirks included"* — was made false by `9cb701b` and nothing re-checks it. This is
   09 §5.1's point exactly: not a missing guard, **one file declining to import the
   shared module** in a repo that has both the module and a gate for it.

   ```js
   import { canonicalUserID } from "./lib/identity.mjs";
   // 09 §2.1/§5.1: was a private `deriveCanonical()` claiming to mirror auth.ts.
   // 9cb701b replaced auth.ts's unanchored .replace() with the anchored shared
   // derivation and this copy was not updated, so for a non-NUS address it
   // returned a truthy "ALICE@GMAIL.COM" while every future session derives "".
   // A private copy is the failure; verify-identity-parity.mjs (C3) now bans one.
   ```

2. **Add `EMPTY_CANONICAL` handling that actually holds, and add `NON_NUS_EMAIL` to
   the skip set (`:281-283`).** With (1) in place, a non-NUS group now derives `""`,
   so `EMPTY_CANONICAL` fires and the existing skip covers it — but `NON_NUS_EMAIL`
   must join the skip set regardless, so the group is refused even if a future
   derivation change makes the empty test miss again. Two independent reasons to
   skip, because 09's whole thesis is that one unstated invariant is not a control.

3. **Adopt `rekey-canonical.mjs:74-95`'s abort.** Before the APPLY loop, if any
   non-skipped plan has a falsy `canonical`, abort the entire run with that script's
   conclusion — *"There is no key this script could write that would be right"* —
   rather than skipping the group and applying the rest. `rekey-canonical` reaches
   the correct conclusion because it never launders `""` into a truthy string;
   `merge-accounts` must reach the same one by the same route.

4. **Gate the singleton A-format block (`:523-551`).** It runs *unconditionally under
   APPLY*, is not gated on the merge's failure list, and its `canonical` at `:527`
   feeds the `UserMatric` upsert at `:544-545`. Add `if (!canonical) continue;`
   inside the loop **and** refuse the whole block if the run aborted under (3).
   `UserMatric.userID` is uniquely indexed (`schema.prisma:431`), so the `""`-keyed
   row lands exactly once and is permanent — it is the row `auth.ts:315`'s early
   return exists to never look up, and it converts §2.4 from latent to live.

5. **`README.md`** — the "Canonical identity per email group mirrors
   `src/server/auth.ts` exactly: `canonical = email.toUpperCase().replace("@U.NUS.EDU","")`"
   line documents the **pre-`9cb701b`** derivation. Replace it with a pointer to
   `lib/identity.mjs` and *no inline formula at all*. 09 §5.5 is right that the doc
   is part of the failure; the durable fix is that the runbook stops restating a
   derivation it cannot keep in sync.

**Depends on:** nothing. **PR:** with C3 — they are one idea (stop private
derivations; prove it) and reviewing them apart wastes the reviewer's context.

**Regression surface — what must NOT change:**

- **The dry-run default.** The script must remain dry-run unless `APPLY=yes`. Do not
  touch the flag handling in this commit.
- **The backup write and its abort-on-failure (`:330-348`).** Untouched. Note for
  the reviewer, not for the diff: it captures only `User` docs, **not dependent
  rows' prior `userID`**, so for a group with ≥2 source IDs an applied merge is
  unreconstructable. That is why (3) aborts rather than skips.
- **The reassign-before-delete ordering (`5a`→`5d`).** Crash-safe ordering is
  load-bearing; leave it exactly as is.
- **Idempotence.** The README promises a re-run is safe. Every change above is a
  refusal, never a new write, so idempotence is preserved by construction — confirm
  it is.
- **`dedupe-users.mjs` is not touched here.** It is a separate script with a separate
  hazard (09 §3.1's `createdAt`-sorts-as-0, bypassable by `FORCE_UNSAFE_DELETE=yes`).
  Out of scope; ticket it.

**Reviewer checks:** `grep -n "toUpperCase().replace" scripts/` returns nothing
outside the allowlisted `legacyCanonicalUserID` (`lib/rbac.mjs:164`); the singleton
block cannot execute after an abort; the README states no formula.

**Verify:** `node scripts/remediation/verify-identity-parity.mjs` exits 0 (it touches
no database — 09 §5.1). **Do not run `merge-accounts.mjs` itself, in any mode, from
this environment.** Its dry run still connects to production Atlas.

---

### C3 — the private-derivation ban  ·  T1 · §5.1 · **the only mechanism that reaches `.mjs`**

> `verify-identity-parity: fail on any private identity derivation under scripts/ or src/`

**Why this is not optional and not replaceable by C9.** Both `[HIGH]` findings live
in `.mjs`. `.mjs` is outside TypeScript's reach entirely — no brand, no
`strictNullChecks`, no `tsc --noEmit`, not now and not after C9. 09 §6's rationale
says this and it is the single most important sequencing fact in the document: **the
type refactor cannot cover the highest-severity findings; this gate is what does.**
If exactly one commit from this plan ships, C1 is the one users need and C3 is the
one that stops the class recurring where nothing else looks.

**File:** `scripts/remediation/verify-identity-parity.mjs`.

**Change.** The gate today compares two implementations over a longhand fixture list
and is well built — DB-free, network-free, CI-safe, and it executes the real
`src/lib/identity.ts` through Node type stripping rather than a transcription of it.
Keep all of that. **Widen its scope from one file pair to the repo**: after the
existing fixture comparison, scan `scripts/**/*.mjs` and `src/**/*.{ts,tsx}` for any
*other* site that derives a canonical id, and exit 1 if one is found.

The detector is a source scan, not a type analysis, so keep it blunt and its
allowlist explicit:

```js
// 09 §5.1: the gate checked ONE file pair while merge-accounts.mjs:84 declared a
// private derivation claiming to mirror auth.ts — and nothing re-checked the
// claim. The parity of two files is worthless if a third has its own copy.
//
// Blunt on purpose: a regex over source, with a NAMED allowlist. A cleverer
// detector would need call-graph reachability (09 §5.4 rejects the ESLint rule
// for exactly this reason) and would be disabled the first time it misfired.
const DERIVATION = /\.toUpperCase\(\)\s*\.replace\(\s*["'`]@U\.NUS\.EDU/i;
const ALLOWLIST = new Set([
  "scripts/remediation/lib/rbac.mjs",   // legacyCanonicalUserID, deliberately frozen
]);
```

Report every hit with `path:line` and the offending line, and print *why* — a bare
exit code teaches nothing and the next author will re-add the copy.

**Prove the gate works, once, by hand:** reintroduce a private derivation, confirm
exit 1, revert. 09's "Done when" requires this and it is the only way to know the
regex matches the shape people actually write.

**Depends on:** C2 (so the gate is green when it lands). **PR:** with C2.

**Regression surface — what must NOT change:**

- **No database, no network, no `PrismaClient`, no connection string.** This
  property is why the gate is CI-safe and it is the easiest thing to destroy while
  "improving" it. A reviewer should check the diff introduces no import that could
  reach one.
- **The existing `FIXTURES` and `ID_FIXTURES` lists are not shortened.** Their
  `expect` values are written out longhand *specifically* so a bug present in both
  implementations still fails — a computed expectation only proves agreement.
- **Exit 0 on agreement, 1 on any divergence.** Unchanged; anything wired to it
  depends on that contract.
- The allowlist has **one** entry. Every addition is a decision, not a fix.

---

### C4 — reject whitespace-bearing emails at registration  ·  T2 · §2.7

> `register: normalize the email before the duplicate probe, not after`

**File:** `src/app/api/register/route.ts` (`:60`, `:77-84`, `:96`, `:101`).

**Change.** Normalize once, at the top, with the shared helper, and use the
normalized value for **the gate, the duplicate probe, the stored `email`, and the
`userID` derivation alike**:

```ts
// 09 §2.7: isNusStudentEmail() trims (identity.ts:41-42) but the duplicate probe
// below folds CASE, not whitespace (`mode: "insensitive"` is a collation). So
// " e1234567@u.nus.edu " passed the gate, missed the existing clean row, and
// created a second User with the SAME userID — an account that can never be
// logged into, because auth.ts:162-165 parses the login form with
// z.string().email(), which rejects surrounding whitespace. Registration
// returned 201. dedupe-users.mjs:110-118 does not catch it either: its unique
// index is collation strength 2, which also folds case and not whitespace.
const email = normalizeEmail(rawEmail);
```

Then `isNusStudentEmail(email)`, the probe on `email`, `email` stored, and
`canonicalUserID(email)` — one value throughout.

**Depends on:** nothing. **PR:** may share a PR with C6/C7/C8 (the T2 server+client
hygiene batch) but is a separate commit; it touches an auth-adjacent route and a
reviewer should be able to see it alone.

**Regression surface — what must NOT change:**

- **The gate order.** `isNusStudentEmail` must still run before any DB work, and the
  400 body must stay `{ error: "Invalid Email" }` — the login/register surface must
  not become an oracle for which domains are accepted (`auth.ts:173-176`'s reasoning
  applies here too).
- **`userID: canonicalUserID(email)` stays non-empty by construction.** The comment
  at `:96-99` asserts this and it is only true because `isNusStudentEmail(e)` and
  `canonicalUserID(e) !== ""` are equivalent by construction (`identity.ts:50-56`).
  Normalizing earlier preserves that; reordering the gate would not.
- **The resident-baseline write that follows the create (G-A / I-8a) is untouched.**
  A user created without it is silently unable to book.
- **Do not add a whitespace-folding index here.** That is a migration, it belongs
  with `dedupe-users.mjs`, and 09 §4.4 is explicit that `dedupe-users.mjs` must not
  run before this fix — it would not catch these rows and would give false
  assurance that duplicates are gone.

**Reviewer check:** exactly one `email` binding is in scope after the change; grep
the file for a second, un-normalized one.

---

### C5 — `MatricGate` handles the empty-identity cohort  ·  T2 · §2.5 · D-C

> `MatricGate: gate on identity, not on the enforcement flag`

**Files:** `src/server/auth.ts` (session type + callback), `src/app/_components/MatricGate.tsx`,
`src/server/api/routers/user.ts` (`getCurrentUserData`), `src/app/profile/page.tsx`.

**Change** — implements D-C:

1. `auth.ts`: add `hasIdentity: boolean` to the `Session["user"]` augmentation
   (`:92-129`), set it as `userID !== ""` at `:303`, and set it `false` on the
   `userID === ""` early-return branch (`:315-341`) alongside the existing fields.
   **No new query** — it is a rename of a value already computed on line 302.
2. `MatricGate.tsx:50`: `const ineligible = authed && session?.user?.hasIdentity === false;`
   The docstring's "INELIGIBLE (`eligible === false`) … MUST be checked first" is a
   load-bearing comment that became false when I-11 made `eligible` flag-aware —
   rewrite it to name `hasIdentity` and say *why* (`eligible` is the enforcement
   decision, `hasIdentity` is the identity fact; they diverge whenever the switch is
   not `enforce`, which is the shipping default).
3. `user.ts:90-97`: return `hasIdentity: false` instead of `eligible: false`;
   `profile/page.tsx`'s `user && !user.eligible` branch reads `!user.hasIdentity`.
   The panel itself is unchanged — it is already the correct pattern (08 §1.2).
4. `auth.ts:335-338`'s comment claims "MatricGate routes ineligible users to the
   ineligibility page before it ever consults hasMatric". After (2) that is true
   again. Leave the comment; it is now load-bearing *and* accurate, which is the
   first time both have held.

**Depends on:** D-C. **PR:** stands alone. It changes what a live cohort sees on
their next page load, it touches the session shape, and it must not be reviewed in a
batch.

**Regression surface — this is the highest-risk commit in the document after C9:**

- **`session.user.eligible` must not change, at all — not its derivation
  (`auth.ts:310-311`), not its type, not its use at `trpc.ts:138`.** It *is* the
  `rbac.auth.enforcement` kill switch as observed by `protectedProcedure`. 09 §5.3:
  refusing the session for an empty canonical is a product change wearing safety
  clothing — it locks out every non-NUS account instantly, recoverable only by
  redeploy, which is *identical in effect to flipping the switch to `enforce`*. Do
  not go near it.
- **Do not add a `hasIdentity` check to `protectedProcedure`.** Same trap, one layer
  down: it would deny every empty-identity session at every procedure, which is the
  flag flip again. `MatricGate` is the UX layer; the server-side denials that
  matter already exist (`access.ts:414-424`, `getUserBookings:336`, the two
  ownership checks).
- **The `ALLOW_LIST` (`MatricGate.tsx:10`) must keep covering `/onboarding`,
  `/login`, `/signup`, `/reset-password`.** More users now hit the redirect, so a
  loop that was theoretical becomes reachable. Confirm `/onboarding/ineligible` is
  matched by `startsWith("/onboarding" + "/")`.
- **The `matricRequired` / `hasMatric` path is untouched.** `UserMatric` is a new
  empty collection; gating on `hasMatric` without the flag bounces every existing
  user to onboarding on deploy day (`trpc.ts:161-167`). This commit must not perturb
  that ordering.
- **`status !== "authenticated"` still renders children untouched.** The public
  surface and the login page must behave exactly as before.

**Reviewer checks:** (1) the `eligible` diff is empty; (2) `hasIdentity` is derived
in exactly one place; (3) `/profile` and `MatricGate` now branch on the same field —
that agreement is the entire point of the commit; (4) no new DB read in the session
callback, which runs on **every** authenticated request (`auth.ts:286-295`).

**Before shipping:** the size of the affected cohort is **unmeasured**. Run
`rbac-doctor.mjs`'s non-NUS list and 09 §4.3 **Q3**
(`User.countDocuments({$or:[{email:null},{email:""}]})`) and record the figures with
a date. Do not estimate them.

---

### C6 — the server-side sentinel guards `7a27304` did not reach  ·  T2 · §2.4 + §3.1

> `Close the remaining empty-identity over-matches in the booking and user routers`

Three sites, one idea, one commit — each is 09's S1/S2/S5/S6 in a place the shipped
fix stopped short of.

**(a) `facilitiesBooking.ts:229-242`, consumed at `:310` — the `userDict` S5
collapse, still live.** `7a27304` fixed the `userTeleHandle` ternary at `:320-323`
and left the dictionary and the `displayName` read one line above it untouched. Two
class members were stacked in one expression and one was fixed. Every `""`-keyed
booking still renders with a stranger's `displayName`.

```ts
// 09 §3.1: filter the sentinel out of the JOIN, not out of each read — a
// ""-keyed booking must resolve to NO user, never to whichever ""-keyed User
// row Object.fromEntries happened to land on. Note `null` keys stringify to
// "null" here and collide the same way (09 §1.2), so the filter is on
// truthiness of the key, not on `!== ""`.
const userIDs = [...new Set(bookings.map((b) => b.userID))].filter(Boolean);
```
and build `userDict` only from rows whose `u.userID` is truthy. Downstream
`userDict[booking.userID]?.displayName` then yields `undefined` — an **under**-match,
a visible blank, which 09 §0.3's ordering principle prefers to a false success.

**(b) `facilitiesBooking.ts:215` — `getBookings`' `userId` filter vanishes on `""`
(S2).** `...(userId ? { userID: userId } : {})` is the correct spread-conditional
idiom for an *optional* filter and the wrong one for an *empty* one: a hand-crafted
request with `userId: ""` drops the condition and gets the dump. It is held closed
today only by two client files passing `enabled: hasIdentity`. The correct server
behaviour for an explicitly-supplied empty `userId` is an **empty result**, not an
omitted filter: reject it at the input schema —
`userId: z.string().min(1).optional()` — so the distinction is made where the value
enters, not where it is spent.

**(c) `user.ts:166-173` — `getMatricStatus` (S6).** Add the guard its two siblings in
the same file already have (`:90`, `:194`):

```ts
// 09 §2.4: the unguarded twin of two guarded siblings in this file. Latent only
// because no ""-keyed UserMatric row exists — and its producer is
// merge-accounts.mjs:544 (09 §2.2), an unrun script. "A ""-keyed row cannot
// exist yet" is a latent finding, not a non-finding.
const userID = ctx.session.user.userID;
if (!userID) return { hasMatric: false, matric: null };
```

Also correct the stale line reference in `access.ts:419`'s comment
(`facilitiesBooking.ts:215-230` → `:229-242`) per §2(e).

**Depends on:** nothing. Ordering note: **C9 will rewrite (a) and (c) as compile
errors.** Doing C6 first means C9's diff at these sites is a simplification rather
than a fix, which is the right order — a compile error you resolve under time
pressure is where a guard gets dropped.

**PR:** with C7 and C8 (the T2 hygiene batch), separate commits.

**Regression surface — the booking path, highest risk in the repo:**

- **`getBookings`' return shape must not change.** `bookings[]` with `id`, `start`,
  `end`, `title`, `user`, `eventName`, `eventDescription`, `userTeleHandle`, plus
  `nextCursor`. The calendar consumes it positionally in places.
- **The multi-day split logic (`:262-287`) and the resort (`:290-295`) are
  untouched.** They are subtle and unrelated.
- **The cursor contract (`:216-224`, `:297-302`) is untouched.** Adding `.min(1)` to
  `userId` must not perturb `cursor`'s own optionality.
- **A booking whose owner is an A-format legacy row must still render exactly as it
  does today** — blank owner name. That is Problem B (08 §0.1), repaired by the
  re-key, and (a) must not be mistaken for a fix to it or accidentally change it.
- **`getUserBookings:336`'s `if (!userID) return []` stays.** It is the shipped fix;
  do not "unify" it into the new idiom.
- **`getMatricStatus` must stay at `protectedProcedure`, not `matricProcedure`**
  (`user.ts:164-165`, `trpc.ts:157`) — a gated user has to call it to render the
  onboarding page, and moving it makes the gate a dead end.

**Reviewer checks:** the `.filter(Boolean)` is on the **key set**, not on the
rendered rows; `userId: ""` now fails input validation rather than returning
everything; `getMatricStatus`'s early return has the same shape as its success
return, so no client branch sees a new field.

---

### C7 — the audit-log filter fails closed  ·  T2 · §2.6 · §5.4

> `AuditLogTable: one identity predicate, shared with the server`

**Files:** `src/app/admin/_components/audit/AuditLogTable.tsx` (`:99-100`),
`src/server/api/routers/admin.ts` (`:67`, export).

**Change.** The client guard is **stricter than the server contract and fails open on
the difference**: `/^E\d{7}$/.test("E1234567 ")` is false, the ternary substitutes
`undefined`, tRPC omits the key, and `admin.ts:1356`'s
`...(input.targetUserID ? {...} : {})` evaluates to `{}` — a `findMany` with an
empty `where`, rendering the 50 most recent audit rows for **every** user with no
error and no empty state. Meanwhile `userIDSchema` (`admin.ts:67`) calls `.trim()`
and `.toUpperCase()` before its regex, so the server would have *accepted* the
pasted string.

Two changes, both required:

1. **Export `userIDSchema` from `admin.ts`** and have the client parse with it. One
   predicate, not two — 09 §5.4's "one real gap zod exposes". A trailing space is
   then normalized away and the filter *applies*, which is what the operator meant.
2. **Fail closed on a value that is present but unparseable.** If the box is
   non-empty and does not parse, do not send `undefined` — render an inline
   "not a valid NUSNET id" hint and **do not run the query**. The failure mode
   09 describes is not "the filter was wrong", it is "the filter silently was not
   there", and only (2) closes that.

**Depends on:** nothing (C9 does not touch this). **PR:** with C6 and C8.

**Regression surface:**

- **`action: action || undefined` and `batchId: batchId || undefined` on the same
  lines are CORRECT and must not be changed.** They are intentionally
  omit-when-blank. The two identity filters reused that idiom for a case where
  omission is not the intent — the fix is to stop sharing the idiom, not to change
  the sharers.
- **`admin.ts:1356`'s server-side spread stays as is.** It is right for an *absent*
  filter; the bug is a client that produces absence from a typo.
- **Batch grouping and the accordion (the page's headline feature) are untouched.**
- **`initialBatchId` deep-linking still works** — it arrives as a prop, not through
  a validated identity box.
- Exporting `userIDSchema` must not change its behaviour at its **11 existing input
  sites**. Export only; do not "tidy" it.

---

### C8 — four admin surfaces stop asserting a confident falsehood  ·  T2 · §2.8

> `Admin panels: distinguish "could not load" from "there is nothing"`

**Files:** `bulk/PendingGrantsPanel.tsx` (`:79`, `:214-220`),
`audit/AuditLogTable.tsx` (`:206-212`), `health/SystemHealthPanel.tsx` (`:87-93`),
`facilities/FacilityAccessTable.tsx` (`:79-80`, `:130-136`).

**Change.** One pattern applied four times. `profile/page.tsx:85-103` is already the
correct implementation in this repo — an `isError` branch with a message and a
"Try again" button that calls `refetch()`. **Copy it; do not invent a second
pattern** (08 §1.2). Concretely, at each site: destructure `isError`, `error` and
`refetch` from the query, and render the error branch **before** the empty branch,
so `data ?? []` can never reach an `EmptyState`.

The reason this is one commit and not four is 09 §2.8's real point: in three of the
four, **the vanished element is a safety warning derived from the same empty array as
the all-clear** — `anyExpiring` (`PendingGrantsPanel.tsx:80-82`), `unconfigured`
(`FacilityAccessTable.tsx:80`), and `residentBaselineMissing`, the one gate on the
enforcement flip (`SystemHealthPanel.tsx:96-97`). Fixing three and missing one leaves
a reader believing the class is closed.

`SystemHealthPanel` needs the most care: `isLoading || !data` (`:87`) renders a
permanent "Loading health…" that never resolves and never admits failure, and it
reproduces most easily — leave `/admin` open past JWT expiry, then change a facility
rule or the enforcement mode; either calls `utils.admin.systemHealth.invalidate()`,
the refetch throws `UNAUTHORIZED`, and the panel — **including the enforcement-mode
selector** — is gone until reload. Split the condition: `isError` → error branch
with retry; `isLoading` → the loading text; `!data` after both → treat as error, not
as loading.

**Depends on:** nothing. **PR:** with C6 and C7.

**Regression surface:**

- **Genuine empty states must still render.** Zero deferred grants with a successful
  query must still say "No deferred grants outstanding." Do not replace the empty
  state; add a branch in front of it.
- **`react-query` keeps previous data on a later failure** — so a panel that has
  loaded once must not flip to the error branch on a background refetch failure.
  09 §2.8 is explicit that the bug requires the **initial** load to fail; the fix
  must not make a transient blip destroy a working page. Check `isError && !data`,
  not `isError` alone, wherever previous data is meaningful.
- **`PendingGrantsPanel`'s `error` Alert (`:103`) is mutation-error state.** Do not
  overload it with query errors; a revoke failure and a load failure are different
  messages. Add a second surface.
- **`SystemHealthPanel`'s enforcement-mode selector must remain reachable in the
  error branch, or say plainly that it is not.** It is the control an operator opens
  this page to reach during an incident.
- No procedure signatures change. This commit is entirely client-side.

---

### C9 — `CanonicalUserID | null`  ·  T3 · §5.2 · D-B · **MUST STAND ALONE**

> `Type the absent identity out of the string domain`

**Do this last, on its own PR, with nothing else in flight.** ~34 threading sites
across `admin.ts` (20), `facilitiesBooking.ts` (6), `user.ts` (4), the admin layouts
(3) and `auth.ts` (1) — mechanical, compiler-verified, and touching the booking path
in a repo with no tests.

**Change** — exactly 09 §5.2, restated only where the spec needs to be executable:

1. `src/lib/identity.ts`: `export type CanonicalUserID = string & { readonly __brand: "CanonicalUserID" }`
   and `canonicalUserID(email): CanonicalUserID | null`, returning `null` where it
   returns `""` today (`:67-70`). **Runtime behaviour is unchanged** — both are
   falsy, so all 14 existing guards keep working and `verify-identity-parity.mjs`'s
   fixture expectations need their `""` entries updated to `null` in the same commit.
2. `auth.ts:96`: `userID: string` → `userID: CanonicalUserID | null`. The
   `userID === ""` branch at `:315` becomes `userID === null`. **`eligible`'s
   derivation at `:310-311` changes form but not meaning** — and per 09 §5.3 and
   D-C's regression list, its *meaning* must not move.
3. `trpc.ts`: add `identifiedProcedure` (09 §5.2's sketch verbatim), narrowing once
   and throwing `FORBIDDEN / NO_CANONICAL_IDENTITY`. Adopt it **only** at procedures
   that already refuse an empty identity today — `getUserBookings`, `setMatric`,
   `createBooking`'s path. Adopting it anywhere new is a behaviour change disguised
   as a refactor, and it is the same flag-flip trap as C5.
4. `userIDSchema` (`admin.ts:67`) gains `.transform(s => s as CanonicalUserID)`.

**What it closes, and what it does not.** S1, S2, S3, S4, S5 die at compile time;
S7 starts working, because `null` *is* nullish and `?? "(anon)"` finally fires.
**S13 survives** — `` `${prefix}:${userID}` `` still compiles and still produces
`"rl:null"` — and needs the runtime assertion, so `rateLimit.ts:62-66` stays a
ticket. Branding does **not** reach `.mjs`, i.e. **neither `[HIGH]` finding**; C3
covers those and nothing else does. It does not reach the `Int` sentinels
(`ccaID: 0`, `facilityID: 0`) unless separately branded — and for those, note 09's
numeric caveat: `if (!ccaID)` is the **wrong guard**, it rejects a legitimate zero;
use `ccaID == null`. It does not touch Problem B.

**Depends on:** D-B, and C1–C8 landed. **PR:** alone.

**Regression surface — treat every compile error as a finding, not a chore:**

- **The errors ARE the sweep (09 §5.2).** Each one is a site that was spending an
  absent identity. Review them; do not silence them. A `!` or an `as string` in this
  diff is the class being re-introduced with the compiler's blessing, and it will
  look like a fix.
- **Runtime behaviour must be identical at every site.** This commit changes types,
  not decisions. If a user's experience changes anywhere, something was
  reinterpreted.
- **The session callback must still never throw** (`auth.ts:286-295`, rule 1) and
  must still issue **zero** extra reads (rule 2). Both are load-bearing on the hot
  path — `auth()` runs on every tRPC request under the JWT strategy.
- **`getUserRoles`'s `if (!userID) return []` (`access.ts:241`) stays.** 09 §1 holds
  it up as the model, and it is what keeps the empty-identity caller out of the
  entire admin router (09 §3.1). Do not let a "the type says non-null now"
  simplification delete it.
- **`isAdmin` / `getBookableFacilityMap` / `getUserRoles` keep accepting
  `string | null | undefined`.** Narrowing their parameters cascades into every
  caller and inflates the diff past reviewability.
- Brands erase at runtime, so no serialized shape changes — but confirm nothing
  round-trips a `CanonicalUserID` through `JSON.parse` and expects the brand back.

**Verify:** `npx tsc --noEmit` clean, `npm run lint` clean,
`node scripts/remediation/verify-identity-parity.mjs` exits 0.

---

## 4. Ordering, conflicts, and the push

### 4.1 Freeze first — costs nothing, blocks the only irreversible outcome

**Before any code:** `merge-accounts.mjs` must not run under `APPLY=yes` until C2
and C3 have landed **and** 09 §4.3's **Q6** has been run and its result recorded.
Q6 is `UserMatric.find({userID:""})`, `User.countDocuments({email:"", userID:/^A\d{7}[A-Z]$/})`,
and the non-NUS duplicate-email groups. This is the only still-open recoverability
window in the entire finding set (09 §4.4), and it closes the moment the script runs,
because the backup captures no dependent-row keys. The freeze is an instruction to a
human, it takes zero engineering time, and it is more important than any commit here
except C1.

### 4.2 Sequence

| Order | Commit | Tier | Blocks on | Ships with |
|---|---|---|---|---|
| — | Freeze `merge-accounts.mjs`; run Q6 | T1 | nothing | n/a |
| 1 | **C1** `getBooking` ownership check | **T0** | D-A | alone, own PR |
| 2 | **C2** shared derivation + abort | T1 | Q6 read | PR with C3 |
| 3 | **C3** private-derivation ban | T1 | C2 | PR with C2 |
| 4 | **C4** register normalization | T2 | nothing | T2 hygiene PR |
| 5 | **C6** server sentinel guards | T2 | nothing | T2 hygiene PR |
| 6 | **C7** audit filter | T2 | nothing | T2 hygiene PR |
| 7 | **C8** admin load-vs-empty | T2 | nothing | T2 hygiene PR |
| 8 | **C5** `MatricGate` / `hasIdentity` | T2 | D-C, cohort figures | alone, own PR |
| 9 | **C9** branded type | T3 | D-B, C1–C8 | alone, own PR |

C4/C6/C7/C8 are order-independent among themselves. C5 is placed after them
deliberately: it is the one T2 commit with a user-visible behaviour change, and it
should not be reviewed in the same window as four hygiene diffs.

### 4.3 Conflicts with the unpushed RBAC work

Seven commits sit unpushed on this branch (`origin/main` = `f25b08c`;
`git rev-list --count origin/main..HEAD` = 7). Several files below are touched by
both that work and this plan.

- **`facilitiesBooking.ts` — C1 and C6 both touch it, and `7a27304` already did.**
  C1 edits `getBooking` (`:141-176`), C6 edits `getBookings` (`:215`, `:229-242`)
  and nothing else. **Non-overlapping ranges; no textual conflict.** But C1 must be
  cherry-pickable onto `f25b08c` on its own — see 4.4.
- **`auth.ts` and `trpc.ts` — C5 and C9 both touch the session shape.** C5 adds
  `hasIdentity`; C9 retypes `userID`. Doing C5 first is deliberate: C9's diff then
  reads as "retype one field", with the product decision already made and shipped.
  Reversing them merges a product decision into a type refactor, which is how a
  reviewer stops reading.
- **`verify-identity-parity.mjs` (C3) and `identity.ts` (C9).** C9 changes
  `canonicalUserID`'s return type from `""` to `null`, so **C9 must update C3's
  fixture expectations in the same commit** or the gate fails. The gate is the point
  — it is *supposed* to notice. Do not weaken it to accommodate the refactor.
- **`admin.ts` — C7 (export `userIDSchema`) and C9 (add `.transform`).** Same
  declaration, four lines apart. Trivial conflict; C7 first.
- **`README.md` (C2) and `scripts/remediation/README.md` (D-B's fallback note).**
  Same file if the fallback is taken. Sequence C2 first.
- **`access.ts` — comment-only edit in C6.** No conflict, but note that the
  `evaluateBookingWithMode` guard at `:414-424` is `7a27304`'s and must not be
  touched by anything in this plan.

### 4.4 The push itself

C1 fixes something live. Everything else is either a script freeze or a fix to code
that has never been served. **That asymmetry should be preserved in how it reaches
production:** C1 is a candidate for cherry-picking onto `origin/main` and deploying
on its own, *before* the seven-commit RBAC branch is pushed — it is one file, one
procedure, no dependency on any RBAC symbol (`isAdmin` and `TRPCError` both exist at
`f25b08c`), and it fixes a live disclosure that predates all of this.

If instead the whole branch is pushed at once, then **every T2 fix becomes a
prerequisite of the push**, because the push is what converts T2 into T0. In that
case C4, C5, C6, C7, C8 are not "cleanup" — they are release blockers, and §2(d)'s
finding that §2.7 is *introduced* by this branch is the clearest example.

Whichever route is taken: **08 §5's standing instruction is unchanged. Do not flip
`rbac.auth.enforcement` to `enforce`** before 08 §2 measures and 08 §3 resolves.
09 §5.3 exists because more than one tempting "fix" in this space flips it by
accident, and D-C's regression list names the two nearest misses.

---

## Done when

Supersedes 09's checklist. The two deployment-check rows are **removed**: the
question is settled from git (§2(a)) and no dashboard read will improve on
`git rev-list --count origin/main..HEAD`.

**T0 — live**
- [ ] `getBooking` applies an ownership check with an admin bypass and returns
      `NOT_FOUND` — not `FORBIDDEN` — to a non-owner (**C1**), **or** D-A's fallback
      is taken and the decision is recorded here with a date.
- [ ] `getBookings`' diff is empty in that commit.

**T1 — the unrun script**
- [ ] `merge-accounts.mjs` has not been run under `APPLY=yes` since this document
      was written, and **Q6's result is recorded here with a date** (09 §4.3).
- [ ] `merge-accounts.mjs` imports `canonicalUserID` from `lib/identity.mjs`, aborts
      the whole run on an empty target key, skips `NON_NUS_EMAIL` groups, and the
      singleton A-format block cannot execute after an abort (**C2**).
- [ ] `verify-identity-parity.mjs` **fails** on a reintroduced private derivation —
      proven by reintroducing one once, observing exit 1, and reverting (**C3**).
      **No private identity derivation exists** under `scripts/` or `src/` except the
      allowlisted `legacyCanonicalUserID` (`lib/rbac.mjs:164`).
- [ ] `scripts/remediation/README.md` no longer states a derivation formula and
      points at `lib/identity.mjs` instead (**C2**).

**T2 — push blockers**
- [ ] `/api/register` normalizes the email once, before the duplicate probe, and the
      whitespace form is rejected or folded — verified before `dedupe-users.mjs` is
      ever run (**C4**).
- [ ] `MatricGate` and `getCurrentUserData` branch on **one** field with **one**
      meaning; `session.user.eligible` is unchanged in derivation, type and use
      (**C5**, D-C). The affected cohort size is **measured** (Q3 + the doctor's
      non-NUS list) and recorded with a date — **not estimated**.
- [ ] A `""`-keyed booking resolves to no user in `getBookings`' join, and an
      explicit empty `userId` is rejected at the input schema rather than dropping
      the filter (**C6**).
- [ ] `getMatricStatus` guards on a falsy `userID`, matching its two siblings in the
      same file (**C6**).
- [ ] The audit-log identity filters share **one** predicate with the server and
      **fail closed** on an unparseable non-empty value (**C7**).
- [ ] Every §2.8 surface distinguishes "could not load" from "there is nothing", and
      **no safety warning derives from an array that is empty on failure** —
      specifically `anyExpiring`, `unconfigured`, and `residentBaselineMissing`
      (**C8**).

**T3 — structural**
- [ ] D-B answered. If approved: `canonicalUserID` returns `CanonicalUserID | null`,
      the session field is typed the same, `tsc --noEmit` is clean, and **the errors
      it raised were reviewed as a sweep rather than silenced** — no `!` and no
      `as string` in the diff (**C9**).
- [ ] The session is **not** refused for an empty canonical (09 §5.3), and the auth
      kill switch still works.
- [ ] It is recorded that C9 does **not** reach `.mjs`, and that C3 is the only
      mechanism that does.

**Standing regression checks (already true — verify, do not implement)**
- [ ] No session with `userID === ""`/`null` can write a `Bookings` row in any mode.
      **Already shipped in `7a27304`** (`access.ts:414-424`, `NO_IDENTITY`); this
      row exists so a later refactor cannot quietly undo it (§2(c)).
- [ ] `rbac.auth.enforcement` has **not** been flipped to `enforce` (08 §5).

**Measurement and hygiene**
- [ ] The `RoleAuditLog` blank-actor census (**Q5**) is recorded — 09 §4.4's one
      durable, unambiguous artifact.
- [ ] `""`-keyed `Bookings` counted and attributed via **Q1**, with **Q3** run for
      the discriminator hole. Figure and date recorded. Note this is now a
      *hygiene* census, not incident forensics: the leak code was never served.
- [ ] Every 09 §3.1 item is promoted to a finding **with a reproduction** or closed
      with a reason. None left in limbo. The named tickets: `rateLimit.ts:62-66`
      (S13, survives C9), `facilityID: -1`, `ccaID: 0` and the numeric-guard caveat,
      `admin.ts:728-750` (`jcrc` self-assigns `cca_head` — an authorization-model
      gap, not a class member), `dedupe-users.mjs`'s `createdAt`-sorts-as-0 and its
      `FORCE_UNSAFE_DELETE=yes` bypass, `merge-accounts.mjs:67-69` (`SupperGroup`
      not reassigned), `cascade.ts` (dead code; becomes live the day a delete button
      is wired to it), `post.ts:28-31`.
- [ ] 09 §3.3's refuted items are **not** re-argued without new evidence.
