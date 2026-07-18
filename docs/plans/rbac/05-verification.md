The governing rule, unchanged from v1: **a passing UI proves nothing.** Every capability check below is executed against the server — from the browser console or a `createCaller` harness — never by clicking. Client affordances are cosmetic (invariant I-7).

The second governing rule, new in v2: **the admin cannot verify this release.** `canBookWithRoles` returns `true` for `admin` before consulting `requiredRoles`, so every booking check passes for the person running the rollout. Any step below marked **[NOT-ADMIN]** must be executed from a second, real, non-admin `@u.nus.edu` account, or from `admin.explainAccess` which evaluates *as the target*. Substituting an admin session for a `[NOT-ADMIN]` step invalidates that step and every conclusion drawn from it.

---

## 0. What changed from v1, and the two invariants this document exists to prove

D-1 inverted the booking default. v1 verified "default-open preserved"; that assertion is now false and every booking case below is rewritten. Three design decisions resolved across the plan set determine what is testable here, and they are restated because the tests only make sense against them:

- **`resident` is STORED, universal and self-healing** (doc 00 I-8, as revised; doc 02 `normalizeStoredRoles`). It is a real value in `UserRole.roles`, held by **every** sign-in-eligible identity including admins, jcrc and cca_head; roles stack and `resident` is the floor, never an alternative. Authorization reads the stored value. Three mechanisms keep it true — **grant at creation** (I-8a), **self-heal at session read** (I-8b), **sticky at every write** (I-8c) — and this document tests all three separately, because any one of them failing alone re-opens a lockout class the other two do not cover. It remains **not** in `GRANTABLE_ROLES` and **not** in `roleSchema`, so it cannot be granted or revoked by any mutation (I-8e). **Consequence for verification: behaviour is no longer sufficient evidence.** Every resident assertion below has a database half — the row must be *there*, not merely *reported*.
- **`suspended` is out of scope for this revision.** It was proposed as the sanction that removes the baseline; it is cut. There is no mutation that removes `resident` from a signed-in NUS account — and removing it directly in the database is not a sanction either, because I-8b puts it back at the target's next page load. Recorded in §15 (the doc's original "§11" pointer predates the section renumbering; §11 is Phase 4).
- **The kill switch's `off` mode means LEGACY semantics, not allow-all.** `off` reproduces pre-D-1 behaviour exactly: a non-empty `requiredRoles` is still enforced, an empty-or-missing one allows. Only `permissive` is allow-and-audit. A blanket-allow `off` would silently un-gate the SCRC Room for the whole soak window.

Everything in this document reduces to two invariants:

> **V-1 (lockout).** There is no reachable state in which a user who can sign in cannot book a normal room.
>
> V-1 now holds **by mechanism** (grant at creation + self-heal at session read + sticky at every write), not **by construction** as it did under derived-resident. The one acknowledged exception is **L-6**: a write failure scoped to `UserRole` while writes elsewhere succeed. That is MITIGATED + DETECTED, never closed, and §7 verifies its detector rather than its absence.
>

> **V-2 (escalation).** No non-admin can acquire, or cause another account to acquire, a capability they do not already hold — including via bulk import, deferred grants, CCA handover, or the allowlist.

§7 proves V-1 on deploy day. §9 proves V-2 from the console.

---

## 1. Personas

Create all of these **before** phase 1. Creating them later means the migration scripts have already run against a population that did not include them, which is the one case the scripts are not idempotent over.

| Persona | Setup | Exists to prove |
|---|---|---|
| `ADMIN` | your account, `roles: ["admin","resident"]`, canonical `E1633673` (D-4) | full capability; **disqualified from every [NOT-ADMIN] step** |
| `ADMIN2` | a second account granted `admin`, also holding `resident` | last-admin and self-revoke guards without bricking yourself |
| `JCRC` | `roles: ["jcrc","resident"]` | reduced capability, D-3 tightening, escalation source |
| `JCRC2` | a second `roles: ["jcrc","resident"]` | peer-revocation guards (a jcrc acting on another jcrc) |
| `CCAHEAD` | `roles: ["cca_head","resident"]`, plus one `CcaHead { userID, ccaID }` row | CCA-gated booking; handover source (doc 07) |
| `RESIDENT` | an `@u.nus.edu` account with **no `UserRole` row at all** | the D-1 baseline. This account must acquire `resident` **by self-heal on its first session read** (I-8b) and then book normal rooms |
| `MULTI` | `roles: ["jcrc","cca_head","resident"]` | multi-role read paths, I-6 positional-shim regression |
| `NOMATRIC` | signed in, no `UserMatric` row | proves `MATRIC_REQUIRED` is distinguishable from a role denial (lockout mode 23) |
| `NONNUS` | a pre-existing non-`@u.nus.edu` row, if §3's audit found any | D-7 denial and its landing page |

`RESIDENT` is the most important persona in this document and the one v1 did not have. Under v1 it was "a user with no roles"; under D-1 it is the entire hall. **Do not create it by granting it anything.** Its whole value is that it has never been touched by any script — which under stored-resident makes it the live test of I-8b rather than of derivation.

**Every persona in this table must hold `resident` in the stored row, admins included.** Roles stack; `resident` is the floor. Assert it directly, once, before running anything else:

```js
db.UserRole.find(
  { userID: { $in: ["E1633673","<ADMIN2_ID>","<JCRC_ID>","<JCRC2_ID>","<CCAHEAD_ID>","<MULTI_ID>"] } },
  { _id: 0, userID: 1, roles: 1 },
)
```
- [ ] Every row listed contains `"resident"` **in addition to** its privileged role. A persona set up as `roles: ["admin"]` alone is not "an admin"; it is an admin who is one `applyRoleChange` bug away from being unable to book, and it silently invalidates §6.2 B-7 and B-11.
- [ ] `RESIDENT` returns **no row at all** at this point. If it has one, the persona has been touched and must be recreated — §7 step 3 is worthless against a pre-materialized account.

There is deliberately no in-app path to mint the first admin. Create `ADMIN2` before testing anything that could remove `admin`; recovery from zero admins requires shell access (§10).

---

## 2. Harness

### 2.1 Browser console (the primary tool — I-7)

The tRPC client uses SuperJSON (`src/trpc/react.tsx:51`), so inputs and outputs are wrapped in `{ json: ... }`. Paste on any app page while logged in as the persona under test:

```js
const call = (path, input, type = "mutation") =>
  fetch(
    `/api/trpc/${path}${type === "query" ? "?input=" + encodeURIComponent(JSON.stringify({ json: input })) : ""}`,
    type === "mutation"
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: input }) }
      : {},
  )
    .then((r) => r.json())
    .then((j) => {
      const err = j?.error?.json ?? j?.[0]?.error?.json;
      console.log(err ? `DENIED ${err.data?.code}: ${err.message}` : JSON.stringify(j, null, 2));
      return j;
    });
```

Two rules for using it:

1. **Never test from the UI.** A disabled switch proves the switch is disabled. It proves nothing about the server.
2. **Every denial must be checked twice** — once for the response code, once for the `RoleAuditLog` row it should have written. A silent rejection is a half-failure: the guard held, but the probe left no trail, and §9 depends on the trail.

### 2.2 `createCaller` harness (for repeatability / CI)

`scripts/remediation/verify-authz.mjs` — the same assertions, runnable without a browser, which is what you want when re-verifying after a fix at 2am:

```js
// Builds a tRPC caller with a synthetic session per persona. The session is
// FABRICATED, which is exactly the threat model: it proves the server does not
// trust session.user.roles (invariant I-5). Every guard must re-read the DB.
import { appRouter } from "../../src/server/api/root";
import { db } from "../../src/server/db";

const callerAs = (userID, fakeRoles = ["admin"]) =>
  appRouter.createCaller({
    db,
    session: {
      user: { id: "x", userID, hasMatric: true, roles: fakeRoles, isAdmin: true },
      expires: "2999-01-01",
    },
    headers: new Headers(),
  });

// THE test that I-5 is real: hand a RESIDENT session a forged roles array
// claiming admin, then call an admin-only mutation. It must still be denied.
await callerAs("<RESIDENT_ID>", ["admin"]).admin.setUserRoles({
  userID: "<PLAIN_ID>", roles: ["admin"],
});   // expect FORBIDDEN, not success
```

That last case is not optional. If a forged `session.user.roles` grants anything, I-5 has been violated somewhere and every other result in this document is meaningless.

---

## 3. Phase A — pre-flight audit (read-only, blocks everything)

Nothing is written in this phase. Its output determines whether several later phases are safe at all, and three of its results are hard gates.

Run from a machine with `DATABASE_URL`:

```bash
node scripts/remediation/rbac-doctor.mjs          # doc 02 §5; read-only, exit 1 on red
node scripts/remediation/verify-admin-id.mjs your.email@u.nus.edu
node scripts/remediation/verify-canonical-rekey.mjs
```

- [ ] `verify-admin-id.mjs` prints `E1633673` (D-4 confirmed, not assumed).
- [ ] **GATE 1 — `verify-canonical-rekey.mjs` reports ZERO orphans**, across **all four** collections keyed on the canonical id: `UserMatric.userID`, `UserRole.userID`, `Bookings.userID` (`prisma/schema.prisma:113`), `UserCCA.userID` (`:368`). Adopting the anchored `canonicalUserID` re-keys any email that is not exactly `X@u.nus.edu`; an orphaned `Bookings` row means that user silently loses every booking they have made and can no longer cancel them (`facilitiesBooking.ts:384` compares ownership on this key). If non-zero, the re-key migration runs **in this phase**, before anything else, and this gate re-runs.
- [ ] **GATE 2 — `db.$runCommandRaw({ count: "User", query: { passwordHash: { $exists: false } } })` is 0**, or `prisma/schema.prisma:353` has been changed to `passwordHash String?`. `PrismaAdapter` creates Google rows without it while the field is declared required and non-nullable — the I-2 shape Prisma throws on. Any lookup added to the session callback throws for those rows and logs the user out entirely.
- [ ] **GATE 3 — the legacy scalars are OPTIONAL in `prisma/schema.prisma` before any backfill runs**: `role String?` (`:247`) and `requiredRole String?` (`:255`). The resident backfill and the facility seed both create documents that omit them; while they are declared required, Prisma throws on read of every such document, taking down `getBookings`, `createBooking` and `deleteBooking` — three runbook steps before the kill switch is even deployed. This is the single most dangerous ordering error in the plan set.
- [ ] Non-NUS `User` rows enumerated and triaged with the user (doc 02 §D-7). The list is reviewed **while sign-in is still open**, because after the guard ships those accounts cannot ask for help from inside the app.
- [ ] `Facilities` enumerated; `scripts/remediation/data/facility-roles.json` hand-written, **keyed on `facilityID`, never on `facilityName`**, and reviewed. The `-1` sentinel is excluded (`Calender_v2.tsx:306` filters it).
- [ ] `UserCCA.userID` key format determined (doc 07 Part 0). `cascade.ts:33-43` deletes from `Bookings` (E-format) and `User` (A-format) with one string, so one of them is already wrong and `UserCCA` sits on the unknown side. **Blocking for doc 07 only** — it does not block phases 1–5.
- [ ] `db.CCA.findOne({ ccaID: 0 })` returns null. `BookingModal.tsx:92` hardcodes `ccaID: 0`, and `cascade.ts:28` deletes `Bookings` by `ccaID` — a real CCA at id 0 turns one CCA deletion into a total booking wipe.
- [ ] `scripts/remediation/backups/` is in `.gitignore` and no dump is in git history (`git log --all --oneline -- scripts/remediation/backups/`). It currently holds `merge-backup.json`, 63 KB of emails and display names, untracked.

---

## 4. Phase D-7 — sign-in restriction (ships BEFORE the resident work)

D-7 gates D-1: until sign-in is restricted, any Google account can mint a canonical userID and therefore acquire the booking baseline. Verify in this order.

| # | Action | Expected |
|---|---|---|
| D7-1 | Register at `attacker@gmail.com` | 400; message names `@u.nus.edu` |
| D7-2 | Register at `E1633673@U.NUS.EDU` (uppercase) | **201.** Regression test for the pre-existing bug at `register/route.ts:51`, which does not lowercase before `endsWith` |
| D7-3 | Credentials login as `NONNUS` | fails; **no session cookie set** — inspect `Application → Cookies`, do not trust the toast |
| D7-4 | Navigate directly to `/api/auth/signin/google`, complete with a personal Gmail | lands on `/login` with the NUS message rendered; **`db.user.count()` unchanged** — this is what proves `signIn` ran before `PrismaAdapter` persisted anything (`next-auth/core/routes/callback.js:78` vs `:104`) |
| D7-5 | **[NOT-ADMIN]** Same, with an `@u.nus.edu` Google account | signs in; `session.user.userID` is canonical |
| D7-6 | **[NOT-ADMIN]** Log in as a non-E-format NUS localpart (`g.s_samuel@u.nus.edu` is real, in `backups/merge-backup.json`) | signs in; `userID === "G.S_SAMUEL"`; **and books a normal room.** This is the test that catches an `E_FORMAT`-based eligibility gate, which would silently lock out every non-E localpart |
| D7-7 | Allowlisted account with `pinnedUserID` set | signs in; `userID` equals the pin |
| D7-8 | Allowlisted account with `pinnedUserID: null` | denied — no `""`-keyed session is ever minted |
| D7-9 | Mint a session as `NONNUS` **before** deploying, deploy, then load any page | lands on the ineligibility page with a **working sign-out button**. Not "roles are empty" — an ineligible session with `hasMatric: false` is otherwise driven into `/onboarding/matric` by `MatricGate.tsx:38` forever, with no reachable escape |

Three checks that are structural rather than per-case:

- [ ] **The denial redirect resolves to an absolute `https` origin on the deployed Vercel domain**, not on localhost. `src/env.js:18-24` preprocesses `NEXTAUTH_URL` from `VERCEL_URL`, which has **no scheme**; a redirect built from it is resolved as a relative path against `/api/auth/callback/` and 404s. Localhost is the one environment where this bug is invisible. Test D7-4 on production.
- [ ] `signIn` returns `false` for the credentials path, never a string. The string branch (`callback.js:368-371`) omits `status`, so `signIn(..., {redirect:false})` computes `ok: true` on the client while no cookie was set — the UI shows a successful login into nothing.
- [ ] **No `AuthAllowlist.pinnedUserID` collides with `canonicalUserID(User.email)` for any user.** A single row `{ email: "attacker@gmail.com", pinnedUserID: "E1633673" }` yields a fully authenticated session whose role key is the admin's, inheriting every `UserRole` and `RoleAuditLog` row bound to it — with no grant path, so no escalation guard ever fires. Assert `pinnedUserID` is `@unique` and namespaced (`EXT:` prefix), and that allowlist writes are admin-only and audited.

---

## 5. Phase 1 — data model

```bash
node scripts/remediation/verify-admin-id.mjs your.email@u.nus.edu
```
- [ ] Derived canonical userID matches the seeded id.

In Atlas or `mongosh`:
- [ ] `db.UserRole.countDocuments({ roles: { $exists: false } })` is **0**.
- [ ] `db.FacilityAccess.countDocuments({ requiredRoles: { $exists: false } })` is **0**.
- [ ] `db.UserRole.findOne({ userID: "E1633673" })` shows `roles: ["admin"]`.
- [ ] A JCRC row shows `roles: ["jcrc"]`.
- [ ] The SCRC Room row shows `requiredRoles: ["jcrc"]`.
- [ ] `db.RoleAuditLog.countDocuments()` equals the number of seeded grants.
- [ ] `db.UserRole.getIndexes()` includes `roles_multikey`; `db.UserRole.getIndexes()` and `db.FacilityAccess.getIndexes()` both show their unique index **actually built** (duplicate `userID` rows are possible if it silently failed, and this repo has a live history of dual-identity duplicates — commits `568c51c`, `fe9afe8`).

**Legacy-mirror correctness during the dual-write window.** Three assertions, each of which corresponds to a blocker found in review:

- [ ] `db.UserRole.countDocuments({ role: { $exists: false } })` is **0** — every row carries the legacy scalar, so the still-deployed pre-v2 client can read it. If Gate 3 made `role` optional this is belt-and-braces; if it did not, this is the difference between a working app and a total outage.
- [ ] **`db.FacilityAccess.countDocuments({ requiredRole: { $nin: [null, ""] } })` is 0** during phases 1–4. The mirror must be written **empty**, not as `requiredRoles[0]`. If a normal room's mirror is set to `"resident"`, the *still-deployed old* `access.ts:36-39` reads it, compares against `getUserRole` → `"user"`, and denies — locking every non-admin out of every normal room days before the cutover, with no kill switch deployed yet.
- [ ] `resident` never appears in `UserRole.role` or `FacilityAccess.requiredRole`. `PRECEDENCE` stays `["admin","jcrc","cca_head"]` (doc 06 §0.1). The mirror exists only so a *revert to pre-v2 code* works, and pre-v2 code is default-open — a `resident` mirror is a value its only consumer cannot interpret, and on the facility side it inverts to a lockout.
  **Storing `resident` does NOT change this.** It is now a real value in `roles[]` and nowhere else: the legacy scalar and the facility-side mirror are untouched by the I-8 revision. Nobody should "helpfully" propagate the now-real baseline into either. `legacyMirror` returns `""` for a resident-only set — a defined empty string, satisfying I-9 on both the insert and the update branch, which is why the role-mutation write needs no `$setOnInsert: { role: "" }` of its own (`$set` and `$setOnInsert` may never name the same path; MongoDB rejects it outright with `ConflictingUpdateOperators`). Assert `legacyMirror(["resident"]) === ""` in a unit test.

**Multi-role dual-write.** Grant `jcrc` to `ADMIN`, then:
- [ ] `db.UserRole.findOne({ userID: "E1633673" })` shows `roles: ["admin","jcrc"]` and legacy `role: "admin"` — **not** `"jcrc"`, and not `roles[0]`.

Idempotency and supersession:
```bash
APPLY=yes node scripts/remediation/seed-roles-v2.mjs   # second run
```
- [ ] Prints `= ... already has` for every id and writes no new audit rows.
- [ ] `scripts/remediation/seed-rbac.mjs` is **deleted**, not guarded. It writes `{ role }` / `{ requiredRole }` directly (`:30-31`, `:48-49`) and hardcodes eleven jcrc grants; one run re-creates the legacy scalar and grants jcrc to eleven ids. Confirm its `Counter`/`bookingID` seed (`:55-66`) was migrated first — nothing else in the plan set carries it.

**Resident backfill** (**AUTHORITATIVE** — a gap here **IS** a lockout, for every id it missed, until that user's next login repairs it):
- [ ] `backfill-resident.mjs` iterates **`User`**, not `UserRole`. Iterating `UserRole` touches 11 rows and misses ~504.
- [ ] Its VERIFY block counts `{ roles: "resident" }` specifically, not `{ roles: { $exists: true } }` — the latter reports success on a half-finished run.
- [ ] Its upserts use `$addToSet` with `upsert: true` and `$setOnInsert: { role: "" }` (the empty string, **not** `null` and **not** `"user"` — see `01-data-model.md` §0.1). No `$set` of a scalar; `ordered: false` so one failure does not abort the batch.
- [ ] Re-run it. Counts are identical and no new audit rows appear.
- [ ] **Eligibility is `isResidentEligible(canonicalUserID(email))` from `lib/identity.mjs`, never `/^E\d{7}$/`.** An E-format gate here withholds the baseline from `g.s_samuel@u.nus.edu` **permanently** rather than mis-deriving it once — the blast radius of L-27 is strictly larger under a stored baseline. Confirm the parity fixture list includes that address.
- [ ] **The VERIFY pass computes a set difference, not a count.** It re-reads `UserRole`, subtracts the materialized set from the eligible set, writes the remainder to `backups/resident-backfill-missing.json`, prints `eligible N  materialized N  MISSING 0`, **names the offending ids** (I-16), and **exits 1** when `MISSING > 0`. A count of rows written is not evidence; only a re-read is.
- [ ] **It prints aggregate `modified` and `upserted` accumulated from the raw command replies.** `$runCommandRaw` returns rather than throws, so "the command succeeded" says nothing about whether anything was written — and these two numbers are the only way the pre-flip re-run gate (§7 step 3b) can tell "already done" from "silently doing nothing".
- [ ] **Per-batch `writeErrors` are inspected and counted as failures.** A batch reply of `{ ok: 1, n: 0, writeErrors: [...] }` is a *failed* batch. A script that reports success on it produces a green run and a locked-out user.
- [ ] Resumability: re-running **is** the resume (`$addToSet` + upsert is idempotent). `ONLY=backups/resident-backfill-missing.json` re-processes just the previous run's failures.
- [ ] Ineligible `User` rows (`test@`, `aaaaaa@`, any non-`@u.nus.edu`) appear in `resident-backfill-plan.json` and are **never granted** (I-8d). This is coherent with D-7 by construction — the same predicate decides sign-in eligibility and grant eligibility. Note that an `AUTH_EMAIL_ALLOWLIST` break-glass restores **sign-in only**: such an account still canonicalizes to `""`, still holds no baseline, and still cannot book.

---

## 6. Phase 2 — backend authz

### 6.0 Grant points (I-8a) — every path that creates a `User` must create a baseline

Because the baseline is stored, an unhooked creation path is a **silent lockout of every account it creates**, and the account looks completely normal until it tries to book. Each check below is behaviour **plus** a direct read of `db.UserRole.findOne({ userID })`.

- [ ] **G-A — credentials registration.** Register a fresh `@u.nus.edu` account via `/api/register`. Immediately, **before that account has ever loaded a page** (so self-heal cannot mask a missing grant), `db.UserRole.findOne({ userID: "<NEW_ID>" })` exists and `roles` contains `"resident"`. Loading a page first invalidates this check entirely.
- [ ] Same registration, canonical key: the row's `userID` is `canonicalUserID(email)` — uppercase, `@u.nus.edu` stripped, **not** `user.userID` and **not** the raw email. A mis-keyed grant looks successful and matches no session (I-1).
- [ ] The row carries `role: ""` from `$setOnInsert` — the empty string, not `null`, not `"user"` (I-9).
- [ ] **G-B — Google first sign-in.** With a never-before-seen `@u.nus.edu` Google account, complete `/api/auth/signin/google`. The hook is `events.createUser`, **not** `callbacks.signIn` (which runs before the adapter writes the row) and **not** `events.linkAccount` (which fires for an existing user adding a provider). Confirm from the code, then confirm from the data: `db.User` gained one row and `db.UserRole` gained a matching row containing `"resident"`, keyed on the canonical id derived from the **email** — `PrismaAdapter` never sets `User.userID`, so a hook reading it keys the grant on `""`.
- [ ] **G-B failure containment.** Force `ensureBaseline` to throw inside `events.createUser` (bad `DATABASE_URL` for the write, or a temporary `throw`). The first sign-in **fails to `/api/auth/error?error=Callback`** unless the hook body is individually try/caught — next-auth v4 awaits `events.createUser` in `callback-handler` and propagates its rejection. Confirm the hook is wrapped, that the sign-in succeeds, and that a `{"evt":"baseline_grant_failed"}` line appears. Then retry the sign-in and confirm I-8b heals the account.
- [ ] **G-D — merge / dedupe scripts.** Run `merge-accounts.mjs` (or `dedupe-users.mjs`) over a pair of test accounts. Afterwards the **survivor's** canonical id holds `"resident"`, and the **loser's** `UserRole` row is gone — not orphaned. An orphan keeps the doctor's "resident row keyed on a non-canonical id" line permanently non-zero, which is how a red line gets muted.
- [ ] **G-E — `seed-rbac.mjs` is deleted**, not guarded (§5 already asserts this). Under a stored baseline it acquires a second reason: it writes `{ role }` with no `roles[]` and no baseline, so one run mints eleven documents that self-heal must later repair.
- [ ] **The gate that keeps this list complete.** `grep -rnE "user\.create|user\.createMany|user\.upsert|createUser|insert:\s*\"User\"" src/ scripts/` — every hit is either a grant point verified above, or carries a comment naming why it is not. Merge-blocking. The narrower grep without `createMany` / raw `insert` misses exactly the shapes the remediation scripts use.
- [ ] **The gate that keeps §0's chokepoint property true.** `grep -rn "getUserRoles\|isAdmin(" src/app/api/ src/server/` — every call site is reachable only from a context that already ran `auth()` (and therefore the session callback and its self-heal), or calls `ensureBaseline` itself. The conversion of most lockout modes from *mitigated* to *closed* rests entirely on repair-before-read at that single chokepoint; a route handler that reads roles without `auth()` consumes an unrepaired baseline. Verified for tRPC today at `src/server/api/trpc.ts:30`; this gate is what keeps it verified.
- [ ] **Non-grant points, asserted absent.** `setMatric` (`user.ts:94`) upserts `UserMatric` only and must **not** acquire a second self-heal call — it is strictly dominated by the session callback that already ran in the same request. `reset-password` creates no users.

### 6.1 Session

- [ ] As `ADMIN`, `/api/auth/session` shows `"roles":["admin","resident"]`, `"isAdmin":true` — **and** `db.UserRole.findOne({ userID: "E1633673" }).roles` contains `"resident"`. The session half alone would also pass under a derivation the code no longer performs.
- [ ] **[NOT-ADMIN]** As `RESIDENT` — an account with **no `UserRole` row** — the same endpoint shows `"roles":["resident"]` **and** `db.UserRole.findOne({ userID: "<RESIDENT_ID>" })` now exists holding `"resident"`. This is the self-heal working: the row was **created before the roles were read**, in the same request.
- [ ] **Empty canonical id is a hard stop.** Plant `db.UserRole.insertOne({ userID: "", roles: ["admin"], role: "" })`, then mint a session whose canonical id is `""`. `/api/auth/session` returns `"roles":[]`, `"isAdmin":false`, and **no** `ensureBaseline` write is attempted. If it returns `["admin","resident"]`, the session callback is querying `UserRole` on the empty key and every non-canonicalizable principal inherits that row wholesale. Delete the planted row afterwards.
- [ ] `db.UserRole.countDocuments({ userID: "" })` is **0** in steady state.
- [ ] No `"bio"` key remains on `session.user`.
- [ ] `roles: Role[]` and `isAdmin: boolean` are declared in the `declare module "next-auth"` block at `src/server/auth.ts:24-36`. Missing, the Phase 2 build does not typecheck — which blocks the deploy that carries the kill switch, leaving the database in the mid-migration state described in §3.

**Live-read proof (the JWT trap).** With `JCRC` logged in in browser A, revoke their `jcrc` from browser B as `ADMIN`. Then in browser A, **without logging out or refreshing the token**:
- [ ] Reload any page → `/api/auth/session` shows `["resident"]`.
- [ ] Booking the SCRC Room now returns FORBIDDEN.

If either still shows `jcrc`, roles have leaked into the JWT and a revoked admin keeps admin for up to 30 days (`session.maxAge`, `auth.ts:119`). Stop and fix (I-4).

**Steady-state write count.** With `RESIDENT` already healed, load a page and watch the query log:
- [ ] The session callback issues **zero** writes and **zero** extra reads. The self-heal is guarded on `!stored.includes("resident")`, which in steady state is one `Array.includes()` over a ≤4-element array. A write on every session read is a write on the hottest path in the app.
- [ ] **The pending-grant path is also zero.** `redeemPendingGrants` stamps `pendingCheckedAt` as its final step **unconditionally** — including the no-pending-grants and expired-grant early returns — so the guard `roleRow?.pendingCheckedAt == null` goes false permanently after one pass. Without the stamp, every session read for every unstamped user re-queries `PendingRoleGrant` forever. Confirm `db.UserRole.countDocuments({ pendingCheckedAt: null })` trends to 0 as users log in, and that a second page load from the same user issues no `PendingRoleGrant` query.
- [ ] **Nothing originated in the session callback can reject unhandled.** `ensureBaseline` returns a boolean and never throws; the fire-and-forget `redeemPendingGrants` has its own internal try/catch **and** a `.catch()` at the `void` call site, logging `{"evt":"pending_grants_failed"}`. An unhandled rejection here is a lambda-level fault on the hottest route in the app — a mass availability event, not a single-user one — and it is triggered precisely by the L-6 condition this design is trying to survive. Test it: delete a user's `UserRole` row, plant a `PendingRoleGrant` for them, break the `UserRole` write, and load a page. The page must render.
- [ ] **The honest residual (L-6).** Force `ensureBaseline`'s write to fail while reads still succeed — a `UserRole`-scoped fault, not a whole-database outage. The session **still resolves**, `roles` does **not** contain `resident`, a `{"evt":"baseline_repair_failed","userID":...}` line appears, and the user is denied with `NOT_RESIDENT`. Confirm all three: the log line exists, `/admin`'s health panel shows the gap, and the standing query (§7) names that userID. This is the acknowledged residual — it is MITIGATED + DETECTED, and these are the detectors.
- [ ] **The detector is not fooled by a MongoDB `writeError`.** `$runCommandRaw` **returns** `{ ok: 1, n: 0, writeErrors: [...] }` on a per-write failure rather than throwing (see `merge-accounts.mjs:168-174`, which reads `nModified` off the reply for exactly this reason). Confirm `ensureBaseline` inspects the **reply** — `writeErrors`, `n`, `nModified`, `upserted` — and not only the exception path. A try/catch-only implementation returns `true` after a failed upsert, logs nothing, and turns the entire L-6 detection story above into dead code.
- [ ] **The E11000 retry actually fires.** Race two concurrent first-session reads for the same brand-new user. Exactly one `UserRole` row exists afterwards, containing `"resident"` exactly once. Then force the interleaving that matters: let a concurrent write insert `{ roles: ["jcrc"] }` while `ensureBaseline` is upserting. The duplicate-key reply must trigger **one retry** (the document now exists, so the retry matches and `$addToSet` applies) — not a silent `return`. Swallowing 11000 as success leaves that user with `["jcrc"]` and no baseline.
- [ ] **Repair-on-deny.** With the repair write failing, attempt a booking. `evaluateBooking` retries `ensureBaseline` before returning `NOT_RESIDENT`; when the retry succeeds it re-reads roles and the booking proceeds. When it fails, the denial stands **and** is logged.
- [ ] **A failing repair does not amplify.** With the `UserRole` write fault still in place, issue ~20 requests from the affected account. The number of attempted repair writes is **bounded** by the per-lambda negative cache / circuit breaker (~30-60s TTL, same shape as the I-11 SystemFlag cache), not one-to-two writes per request. Then simulate the mass-cold-start case — restore a `UserRole` collection with the baseline stripped from all ~515 rows — and confirm p95 session latency stays inside budget as everyone heals on their next page load. Unbounded, a fault on one collection becomes an app-wide latency event.

**Scope boundary (I-8b).** The repair-before-read guarantee holds **only** for requests that traverse the Next.js session callback:
- [ ] Any other consumer of `UserRole` — the droplet Python backends, bots, cron, one-off scripts — either calls the same idempotent top-up or treats a missing baseline as **unknown**, never as denied. Under derivation there was no unhealed value for them to see; there is now. Enumerate those consumers and record which of the two they do.

### 6.2 Booking authorization — the inverted table

Every row here is the opposite of v1's. Run in `enforce` mode against a scratch flag value (§8 covers the mode transitions themselves).

| # | Persona | Facility | Expected |
|---|---|---|---|
| B-1 | **[NOT-ADMIN]** `RESIDENT` | any normal room | **succeeds** |
| B-2 | **[NOT-ADMIN]** `RESIDENT` | a facility with **no `FacilityAccess` row at all** | **succeeds** — missing row defaults to `["resident"]`, not deny-all |
| B-3 | **[NOT-ADMIN]** `RESIDENT` | a row with `requiredRoles: []` | **succeeds** — empty array is the same state as missing |
| B-4 | **[NOT-ADMIN]** `RESIDENT` | SCRC Room | FORBIDDEN, reason `ROLE_REQUIRED`, `requiredRoles: ["jcrc"]` |
| B-5 | **[NOT-ADMIN]** `RESIDENT` | a CCA room | FORBIDDEN, reason `ROLE_REQUIRED` |
| B-6 | `JCRC` | SCRC Room | succeeds |
| B-7 | `JCRC` | a normal room | succeeds — a role does not *replace* the baseline |
| B-8 | `CCAHEAD` | any CCA room, including one they do not head | succeeds (D-1: flat, deliberately no per-CCA check) |
| B-9 | `CCAHEAD` | SCRC Room | FORBIDDEN |
| B-10 | `MULTI` | SCRC Room and a CCA room | both succeed |
| B-11 | `ADMIN` | everything | succeeds (implicit bypass) — **and proves nothing**, which is the point of the `[NOT-ADMIN]` marking above |
| B-12 | `NOMATRIC` | any room | FORBIDDEN with `MATRIC_REQUIRED` — a **distinct** message from every role denial — **but only while `rbac.matric.enforcement` is `enforce`**. See B-13: this gate is NOT pre-existing, and it is off by default |
| B-13 | **[NOT-ADMIN]** any existing user **with no `UserMatric` row**, `rbac.matric.enforcement` absent or `off` | any normal room | **succeeds**, and `/` , `/profile`, `/admin` all render normally rather than redirecting to `/onboarding/matric` |

- [ ] **B-13 is a deploy-day blocker, not a nicety.** `UserMatric` is a NEW collection introduced by this change and NOTHING backfills it (`backfill-resident` / `backfill-roles-v2` / `seed-roles-v2` write `UserRole` and `FacilityAccess` only), so on deploy `hasMatric` is false for **100%** of the ~515 existing users. An ungated matric check is therefore a total outage — blank-and-bounce on every page, plus `createBooking`, `updateBooking` (so nobody can even shorten a booking they already hold) and `post.create` all throwing `MATRIC_REQUIRED`. `rbac.booking.enforcement` does **not** reach this path, which is why the gate carries its own `rbac.matric.enforcement` flag (`getMatricEnforcement`, default `off`) consumed by BOTH `matricProcedure` and `MatricGate` (via `session.user.matricRequired`). Verify B-13 with the flag row **absent**, which is the state a fresh deploy is actually in.
- [ ] Only after B-13 passes, set the flag to `enforce` and re-run B-12. Flip it back to `off` and confirm B-13 passes again **without a redeploy** — a switch that cannot be reverted live is not a switch.
- [ ] **D-7 has no such switch, by design.** Before deploying, confirm no active account uses a non-`@u.nus.edu` address: `protectedProcedure`'s `NUS_ACCOUNT_REQUIRED` denial is unconditional, so any such account loses every capability on deploy with no flag-flip remedy. Such a session must land on `/onboarding/ineligible` (explanatory page + working sign-out), never on `/onboarding/matric`, where `user.setMatric` would reject them with an opaque `NUS_ACCOUNT_REQUIRED` forever (D7-9).

- [ ] B-2's default is unchanged (I-10, fail-safe: a missing `FacilityAccess` row means `["resident"]`) but its **justification** is not. Under derivation that default had no lockout path at all; under a stored baseline a user whose baseline is missing is denied on **every** normal room, not only gated ones. The default is still correct — majority case, bounded-over-permissive — and its lockout path is closed by I-8b, which is why the self-heal tests above are prerequisites for trusting this row rather than adjacent to it.
- [ ] B-7 and B-11 have a database half: `db.UserRole.findOne` for `JCRC` and for `ADMIN` both contain `"resident"` alongside their privileged role. If either books a normal room while lacking the stored baseline, the booking succeeded for the wrong reason (a bypass, or a stale session) and the row proves nothing.
- [ ] B-4/B-5 return a structured `reason` code, not a bare `"You are not allowed to book this facility."` The reason is surfaced to the user; a blank FORBIDDEN turns every denial into a support ticket.
- [ ] `admin.explainAccess({ userID: "<RESIDENT_ID>", facilityID: <N> })`, called as `ADMIN`, returns the same decision B-1..B-5 produced from the real session. This is what lets the admin verify without holding the non-admin session — and it is why `explainAccess` must itself be audited and admin-gated (it is an enumeration primitive over the whole user base).

**The picker must not advertise what it will refuse.** Under D-1 most rooms are gated for most users, so "renders in the list, fails at submit" is now the dominant path rather than an edge case:
- [ ] **[NOT-ADMIN]** As `RESIDENT`, the booking modal renders SCRC and CCA rooms **disabled, with the reason**, sourced from `getFacilitiesForBooking` — not from `getAllFacilities`.
- [ ] `getAllFacilities` is **retained unchanged** and still consumed by `Calendar.tsx:24` and `PastBookings.tsx:66`, both display-only. Grep gate before merge: no `getAllFacilities` call site decides whether a booking control is enabled.
- [ ] `createBooking` remains the enforcement point (I-7). Disable the client filter in devtools, submit a gated room, and confirm the server still refuses.

**The I-6 regression.** Grant `ADMIN` a second role so their array is `["admin","jcrc"]` — then try `["jcrc","admin"]`:
- [ ] `bookings.getBookings({ seeAll: true })` still returns the full dump in both orders.
- [ ] `ADMIN` can still delete another user's booking in both orders.
- [ ] `grep -rn "getUserRole\b" src/` returns nothing. `roles[0]` is `$addToSet` insertion order; a positional shim silently drops admin at `facilitiesBooking.ts:131` and `:384`.

**`updateBooking`.** Currently `protectedProcedure` with an ownership check only (`:404-458`):
- [ ] **[NOT-ADMIN]** Revoke `JCRC`'s role, then have them extend an existing SCRC booking. Expect the same `ROLE_REQUIRED` denial as `createBooking`. Without a re-check, a revoked user reschedules a gated booking indefinitely.

### 6.3 Regex safety

```js
call("admin.listUsers", { search: "(a+)+$", limit: 25 }, "query");
```
- [ ] Returns promptly (escaped to a literal) rather than hanging.

---

## 7. DEPLOY-DAY LOCKOUT VERIFICATION

This is the procedure that decides whether the hall can book tomorrow. It runs in order and **stops on the first red line.** Every step is reversible until step 9.

The design property being relied on is no longer derivation. It is this, and it is the single sentence the whole procedure verifies:

> **Every authoritative role check in this application is preceded, in the same request, by a run of the NextAuth `session` callback** (`src/server/api/trpc.ts:30` → `auth()` → `callbacks.session`, JWT strategy, no server-side session cache). A repair placed inside that callback therefore runs **before** anything can consume the roles.

Against `00-overview.md` §5's class table: of the modes the old I-8 closed by derivation, **most are re-closed structurally** by the grant/heal/sticky triple, and **five are MITIGATED + DETECTED** — the `UserRole`-scoped partial write failure (L-6), canonical key drift (whose matric/booking half I-8 never closed either), the required-scalar fault (held by I-9 and Gate 3, and now *more* load-bearing because self-heal creates documents on the hot path), invisibility (a detector is detection, never closure), and the multi-process boundary (§6.1's scope note). The steps below verify the three mechanisms are actually wired, and exercise the detectors for the five that remain.

**Step 1 — before the deploy.**
```bash
node scripts/remediation/rbac-doctor.mjs
```
- [ ] `users(INELIGIBLE)` — every row triaged, none of them yours
- [ ] `canonical id collisions` — **0**
- [ ] `canonical id empty (blank email)` — **0**
- [ ] `UserRole rows keyed on a non-canonical id` — **0** (I-1; a mis-keyed grant looks successful and matches no session)
- [ ] `UserRole rows missing legacy role scalar` — **0** (or Gate 3 applied)
- [ ] `FacilityAccess rows missing legacy requiredRole scalar` — **0**
- [ ] `facilities UNCONFIGURED` — **0**
- [ ] `stored requiredRoles containing "admin"` — **0** (admin is an implicit bypass, never stored; storing it invites someone to edit the array and lock admins out)
- [ ] `enforcement mode` — `off`

**Step 2 — deploy Phase 2 code with the flag at `off`.** Booking behaviour must be byte-identical to the morning. The only user-visible changes are the sign-in restriction and the disabled options in the picker.
- [ ] **[NOT-ADMIN]** `RESIDENT` books a normal room → succeeds.
- [ ] **[NOT-ADMIN]** `RESIDENT` books the SCRC Room → **still FORBIDDEN.** This is the check that catches an `off` mode implemented as blanket-allow. If SCRC becomes bookable here, `off` has un-gated it for the entire soak window; revert immediately.
- [ ] `JCRC` books SCRC → succeeds.

**Step 3 — the self-heal smoke test. [NOT-ADMIN]**
- [ ] Sign in as `RESIDENT` for the first time since the deploy. `/api/auth/session` shows `["resident"]`.
- [ ] `db.UserRole.findOne({ userID: "<RESIDENT_ID>" })` now exists, holds `"resident"`, and carries `role: ""`.
- [ ] **Delete that row by hand.** Reload one page. The row **comes back**, `roles` is `["resident"]`, and booking still works. **This is the single most important assertion in the document** — it now proves I-8b rather than derivation, and it is if anything more important, because it is the only evidence that a hand-edit, a restored backup, a mis-keyed backfill or an account created before this shipped repairs itself instead of stranding the user.
- [ ] Do it once more, but check the **order**: the repaired row exists *before* the booking call is made, i.e. the repair happened in the session read, not lazily at book time. Delete the row, then make the booking call as the first thing after reload; it must succeed on the first attempt, not the second.

**Step 3b — the backfill completeness gate.**
```bash
node scripts/remediation/backfill-resident.mjs        # dry-run, then APPLY=yes
```
- [ ] Prints `MISSING 0`, `modified 0`, `upserted 0`, and **exits 0**.
- [ ] Any non-zero `modified`/`upserted` on this re-run means an eligible account was created since the last run **without** receiving a baseline — i.e. G-A or G-B is broken. The set difference alone cannot detect this, because the write lands and `MISSING` is 0 either way. **Blocks step 9** pending an explanation.
- [ ] Any non-zero `MISSING` names the offending ids in `backups/resident-backfill-missing.json`. Investigate the `baseline_repair_failed` lines, re-run with `ONLY=` that file, and re-gate.

**Step 4 — the sticky test.** `resident` must survive **every** write that carries a role payload. As `ADMIN`, open `RESIDENT` in the dashboard and grant then revoke `cca_head`.
- [ ] After the round trip, `RESIDENT` still books a normal room.
- [ ] **And inspect the stored document directly:** `db.UserRole.findOne({ userID: "<RESIDENT_ID>" }).roles` still contains `"resident"`. Under derivation the read being right was sufficient; it no longer is. A behaviour-only check here passes against a write that has just stripped the baseline, right up until the session cache turns over.
- [ ] `roleSchema` / `GRANTABLE_ROLES` do **not** contain `resident`. Attempt `call("admin.setUserRoles", { userID: "<RESIDENT_ID>", roles: ["resident"] })` → zod BAD_REQUEST. The mechanism is not that `resident` is filtered out of the removal set — it is that `removed ⊆ before ∩ GRANTABLE_ROLES`, so `resident` is **incapable of entering** a removal payload (I-8c).
- [ ] Repeat the stored-document check after each of the other three payload-carrying paths, because they are the ones the UI never touches:
  - `set`-mode **bulk import** onto a user holding `["cca_head","resident"]` → baseline still present.
  - **Bulk undo** of an import whose `rolesBefore` was `[]` → baseline still present. This is the mass-strip case; verify against ≥10 targets, not one.
  - **Deferred-grant redemption** at first login → baseline still present, and the redemption wrote `$addToSet: { roles: { $each: granted } }`, never a set-payload computed from a prior read (I-13).
- [ ] **The write-shape gate.** No Prisma `data:` object anywhere in `src/server/api/services/` or `src/server/api/routers/` contains a `roles` key — assert this with an AST check in the verification script, **not** a line-based grep. A line-based grep produces false positives on multi-line `$addToSet: {\n roles: ...` and, per the I-16 corollary, a gate that cannot reach zero gets muted, which deletes the detector.
- [ ] **A failed role write is never audited as a success.** `applyRoleChange` inspects the raw reply's `writeErrors` and throws **before** `writeAudit`. Force a write failure and confirm the mutation surfaces an error and `RoleAuditLog` gains **no** `ok: true` row. A silently-failed `$pull` demotion with a success audit row is a security failure, not a cosmetic one: the revoked admin keeps admin and the log says otherwise.
- [ ] **Concurrent grant and revoke on the same target produce one success and one `CONFLICT_ROLES_CHANGED`** — never a merged state neither actor requested. The delta write is guarded by a compare-and-set on the observed pre-image; a bare `$pull`/`$addToSet` pair lets a concurrent grant silently undo a revocation while both audit rows claim success.
- [ ] **Two simultaneous admin self-revocations leave exactly one admin.** The last-admin guard and the roles write must be one atomic operation. If the write was converted to a raw command inside `db.$transaction`, it does **not** join that transaction's session under the Mongo connector and the guard is no longer atomic with what it guards — the exact race §9.2 exists to prevent. Run it concurrently and check `db.UserRole.countDocuments({ roles: "admin" })`.
- [ ] The dashboard renders `resident` as a **read-only badge**, not a checkbox. The server cannot express its removal, so the UI-level sticky list in `03-admin-dashboard.md` §10.4 is now only a copy-consistency aid — but a rendered checkbox would still make the preview lie about what the server will do.

**Step 5 — the facility-coverage test.** For **every** `facilityID` in `Facilities` except `-1`, call `admin.explainAccess({ userID: "<RESIDENT_ID>", facilityID })`.
- [ ] Every normal room returns `ok: true`.
- [ ] Every intentionally gated room returns `ok: false` with the intended `requiredRoles`.
- [ ] The set of gated rooms **exactly** equals `facility-roles.json`. A room gated by accident is a lockout; a room un-gated by accident is an exposure.

**Step 6 — flip to `permissive`.**
```bash
node scripts/remediation/set-enforcement.mjs permissive
```
- [ ] Live within 15s (the per-lambda cache TTL) without a redeploy.
- [ ] A would-be denial now **succeeds** and writes `action: "booking.denied.shadow"`, `ok: false`, with `denyReason` and `targetUserID`.

**Step 7 — soak, minimum 72 hours spanning a weekday and a weekend.** Read the shadow log daily:
```js
db.RoleAuditLog.aggregate([
  { $match: { action: "booking.denied.shadow", at: { $gte: new Date(Date.now() - 864e5) } } },
  { $group: { _id: "$denyReason", n: { $sum: 1 }, users: { $addToSet: "$targetUserID" } } },
])
```
- [ ] `NOT_RESIDENT` count is **0**. Any non-zero value is a real user who would have been locked out. Take the userID, run it through the doctor, fix the cause, **restart the 72-hour clock.**
- [ ] Every `ROLE_REQUIRED` is explainable as a genuine attempt on a genuinely gated room.

**Step 8 — the drill.** Do not skip; §8.

**Step 9 — flip to `enforce`.** Announce it first. Watch the denial log for the first hour.
- [ ] **Prerequisite — re-run step 3b immediately before the flip**, to catch everyone created during the soak window. `MISSING 0`, `modified 0`, `upserted 0`. If it writes anything, a grant point is broken and **the flip is blocked** until that is explained; the accounts it just repaired would otherwise have been locked out the moment enforcement turned on.
- [ ] **Prerequisite — the standing query below returns empty.** Under a stored baseline this is a gate, not a dashboard.
- [ ] **[NOT-ADMIN]** `RESIDENT` books a normal room within five minutes of the flip.
- [ ] Denials in the first hour match the shadow-mode profile. A new denial class means something changed between soak and enforce.

**Standing detection query**, run daily thereafter — mode 26 exists because nothing computed this. Scope it to the population the auto-grant can actually cover, or it never reaches zero and gets muted:

```js
// Eligible NUS accounts that have signed in since cutover but hold no resident row.
// Non-NUS rows are EXCLUDED by design (D-7: they cannot sign in, must not hold resident).
// Returns the offending userIDs, not a count — a count nobody can act on gets ignored.
db.User.aggregate([
  { $match: { email: /^[A-Za-z0-9._%-]+@u\.nus\.edu$/i } },
  { $addFields: { cid: { $toUpper: { $arrayElemAt: [{ $split: ["$email", "@"] }, 0] } } } },
  { $lookup: { from: "UserRole", localField: "cid", foreignField: "userID", as: "r" } },
  { $match: { "r.roles": { $ne: "resident" } } },
  { $project: { _id: 0, cid: 1, email: 1 } },
])
```
- [ ] Reviewed daily. A non-empty result **IS a lockout** for every id listed, until each of them next loads a page and I-8b repairs them. Investigate the `{"evt":"baseline_repair_failed"}` and `{"evt":"baseline_grant_failed"}` log lines, re-run the backfill (§7 step 3b), and **do not flip to `enforce` while it is non-empty.** This line was advisory under derived-resident; it is a red line now, and `rbac-doctor.mjs` carries the same check with the same severity.
- [ ] The inverse also holds: `db.UserRole.countDocuments({ roles: "resident", userID: /@/ })` is **0**. A `resident` row keyed on something containing `@` means a non-NUS identity acquired the baseline.

---

## 8. Kill-switch drill — prove the revert BEFORE you need it

An untested revert is not a revert. Run the whole drill in `permissive` (step 8 above), when nothing is on fire and everyone is awake.

The drill exists because an environment variable **cannot** be the kill switch on Vercel: env changes are snapshotted per deployment and require a redeploy to take effect. The live tier is a `SystemFlag` row read behind a 15s per-lambda cache; the env var is only the deployment-level default.

1. Note the wall-clock time. Flip to `enforce`:
   ```bash
   node scripts/remediation/set-enforcement.mjs enforce
   ```
2. **[NOT-ADMIN]** From `RESIDENT`, poll a gated room until it starts refusing.
   - [ ] Takes **≤ 15 seconds**. Longer means the cache TTL was raised; lower it back. The entire value of this switch is time-to-revert.
3. Revert:
   ```bash
   node scripts/remediation/set-enforcement.mjs off
   ```
   - [ ] Gated behaviour returns to pre-D-1 within 15s.
   - [ ] **No redeploy was performed.** If you had to redeploy, the switch does not exist and the rollout must not proceed.
4. Repeat from a second browser on a different network, to confirm all lambda instances converge and you did not simply observe one warm instance.
   - [ ] Converges within 15s.
5. Delete the `SystemFlag` row entirely.
   - [ ] The system falls back to `RBAC_BOOKING_ENFORCEMENT` (default `off`), and **not** to `enforce`. A wiped collection must never silently enforce.
6. Break the database connection (bad credentials in a scratch deployment) and hit the booking path.
   - [ ] `getEnforcementMode` fails **open to `off`** — legacy semantics — rather than throwing or denying. An Atlas hiccup must not lock out the hall.
7. Restore the row.
   - [ ] `rbac-doctor.mjs` reports the expected mode.

- [ ] The exact revert command is written on the runbook card, along with who has `DATABASE_URL` access at 2am. A drill nobody can repeat under pressure has not been run.

---

## 9. Escalation testing — from the console, as the persona (I-7)

Every line is run in the browser console **as the named persona**, never as admin, never by clicking. Every line must produce both the expected denial **and** a `RoleAuditLog` row with `ok: false`, `action: "denied"`, and a `denyReason`.

### 9.1 As `JCRC`

```js
call("admin.setUserRoles", { userID: "<JCRC_OWN_ID>",  roles: ["jcrc","admin"] });    // CANNOT_GRANT_ADMIN
call("admin.setUserRoles", { userID: "<RESIDENT_ID>",  roles: ["admin"] });           // CANNOT_GRANT_ADMIN
call("admin.setUserRoles", { userID: "E1633673",       roles: ["jcrc"] });            // CANNOT_MODIFY_AN_ADMIN  <- escalation by demotion
call("admin.setUserRoles", { userID: "E1633673",       roles: [] });                  // CANNOT_MODIFY_AN_ADMIN
call("admin.setUserRoles", { userID: "<RESIDENT_ID>",  roles: ["jcrc"] });            // CANNOT_GRANT_JCRC       <- D-3, REVERSES v1
call("admin.setUserRoles", { userID: "<JCRC2_ID>",     roles: [] });                  // CANNOT_REVOKE_JCRC_FROM_OTHERS
call("admin.setUserRoles", { userID: "<JCRC_OWN_ID>",  roles: ["jcrc","cca_head"] }); // CANNOT_SELF_ASSIGN
call("admin.setUserRoles", { userID: "a1234567b",      roles: ["jcrc"] });            // zod reject (not E-format)
call("admin.setUserRoles", { userID: "<RESIDENT_ID>",  roles: ["superuser"] });       // zod reject (enum)
call("admin.setUserRoles", { userID: "<RESIDENT_ID>",  roles: ["resident"] });        // zod reject — resident is not grantable
call("admin.setFacilityAccess", { facilityID: <SCRC_ID>, requiredRoles: [] });        // ADMIN_REQUIRED
call("admin.setFacilityAccess", { facilityID: <SCRC_ID>, requiredRoles: ["admin"] }); // zod reject — admin never stored
call("admin.listAuditLog", { limit: 5 }, "query");                                    // ADMIN_REQUIRED
call("admin.explainAccess", { userID: "E1633673", facilityID: 1 }, "query");          // audited, and admin-gated
```

- [ ] **`CANNOT_GRANT_JCRC` is the D-3 line.** v1 asserted this *succeeds*. It must now be denied and audited. Under D-3 only admins grant or revoke `jcrc`; a jcrc grants `cca_head` only.
- [ ] Every line returns FORBIDDEN or a zod BAD_REQUEST with the expected message.
- [ ] Every line produced an `ok: false` audit row. Check on `/admin`.
- [ ] **Denial audits survive their transaction.** Guards that `throw` inside `db.$transaction` roll back their own audit row. Confirm the denial rows are written on `ctx.db`, outside the transaction, then rethrown — otherwise the abuse-detection story is fiction on exactly the surfaces most likely to be probed.

Allowed operations, as `JCRC`:
- [ ] Grant `cca_head` to `RESIDENT` → **denied with `USE_CCA_HEAD_ENDPOINT`.** `cca_head` is removed from the generic grant path (doc 07) so the `CcaHead` scope row cannot drift from the flat role string. It is granted only via `admin.grantCcaHead({ userID, ccaID })`.
- [ ] `call("admin.grantCcaHead", { userID: "<RESIDENT_ID>", ccaID: <N> })` → succeeds; audit `ok: true`; **and** a `CcaHead` row appears; **and** the stored `UserRole.roles` is `["resident","cca_head"]` in some order — the baseline survived a create-branch write, which is the exact shape a `create: { roles: ["cca_head"] }` payload would destroy.
- [ ] Revoke own `jcrc` (step down) → succeeds. Note the D-3 consequence: **no peer can restore it**, only an admin. Re-grant as `ADMIN`.

### 9.2 As `ADMIN` — lockout guards

```js
call("admin.setUserRoles", { userID: "<ADMIN_OWN_ID>", roles: [] });   // CANNOT_SELF_REVOKE_ADMIN
```
- [ ] Rejected.
- [ ] With `ADMIN2` present, reduce to a single admin, then have that admin's admin removed → `PRECONDITION_FAILED / CANNOT_REMOVE_LAST_ADMIN`.
- [ ] `db.UserRole.countDocuments({ roles: "admin" })` never reaches 0 at any point during the sequence.
- [ ] The last-admin count query is narrowed from `OR: [{roles:{has}},{role}]` to roles-only **only after** phase 1's gate proved no legacy-only row remains. Narrowing it early makes a legacy-only admin invisible to the count and permits removing the real last admin.

### 9.3 As `CCAHEAD` — handover (doc 07)

```js
call("admin.transferCcaHead", { ccaID: <N>, fromUserID: "<CCAHEAD_ID>", toUserID: "<CCAHEAD_ID>" });   // TRANSFER_TO_SELF
call("admin.transferCcaHead", { ccaID: 99999, fromUserID: "<CCAHEAD_ID>", toUserID: "<RESIDENT_ID>" }); // NO_SUCH_CCA
call("admin.transferCcaHead", { ccaID: <N>, fromUserID: "<JCRC_ID>",     toUserID: "<RESIDENT_ID>" }); // NOT_A_HEAD_OF_THIS_CCA
call("admin.transferCcaHead", { ccaID: <N>, fromUserID: "<CCAHEAD_ID>",  toUserID: "E9999999" });      // target must be a real signed-in user
```
- [ ] All denied. Self-serve handover is **not** shipped in this phase; the caller is always an admin or jcrc.
- [ ] A caller cannot name **themselves** as `toUserID` unless they already hold `cca_head` — `NO_SELF_ASSIGNMENT`. Without this a jcrc self-grants `cca_head` and acquires CCA-room booking.
- [ ] A successful transfer leaves the CCA with **≥1 head at all times**: grant to the successor happens before the revoke, in one transaction. A crash between the two must leave two heads, never zero.
- [ ] Both halves share one `batchId` and both carry `targetCcaID`.

### 9.4 Bulk and deferred grants (doc 02 §D-8)

This surface is where escalation hides, because it is the only path that writes privilege for an identity that does not yet exist.

- [ ] **A 1000-row preview completes.** `previewBulkImport` is a `.mutation()` (POST). As a `.query()` it is serialized into the URL by `unstable_httpBatchStreamLink` and 414s at roughly ten rows of realistic CSV.
- [ ] Preview 500 rows including 40 denials → `RoleAuditLog` gains **zero** rows. A dry run that audits its own hypotheticals poisons the log.
- [ ] A chunk commit of the configured size completes inside the function timeout. Commit 500 rows end to end and confirm no chunk truncates; a truncated chunk has already applied some rows with no way for the client to learn which.
- [ ] One malformed userID in a chunk fails **that row only**. If it 400s the whole chunk, per-row identifiers are being validated by the top-level zod schema, which is all-or-nothing per request.
- [ ] As `JCRC`, a bulk row granting `jcrc` → every such row denied (D-3), audited `ok: false`, other rows in the batch still succeed.
- [ ] A `set`-mode import onto a user holding `["cca_head","resident"]` still leaves them booking normal rooms afterwards, **and their stored `roles` still contains `"resident"`**. Bulk is the mass-strip surface: it runs the same per-row `assertCanMutateRoles` → `applyRoleChange` pair, so if the chokepoint is right this is automatic and if it is wrong this fails for hundreds of users at once. Check the stored rows, not the behaviour — do it over ≥10 targets.
- [ ] Change a target's roles between preview and commit → that row returns `CONFLICT_ROLES_CHANGED`, is audited as a denial, and the batch otherwise completes.
- [ ] **A pending grant is keyed ONLY on a canonical E-format userID derived from an `@u.nus.edu` address** — never a matric, never a display name. `UserMatric.matric` is self-asserted (`user.ts:85-99` upserts whatever the user types) and `User.displayName` is nullable and non-unique. A grant keyed on either is claimed by whoever first presents that identifier.
- [ ] **Redemption re-authorizes.** Create a pending `cca_head` as `JCRC`, revoke `JCRC`'s role, then sign the target up. The deferred role is **dropped**, and the drop is audited. A grant that fires on the authority of a demoted granter is escalation surviving its own revocation.
- [ ] A pending grant past `expiresAt` is not claimed at first login.
- [ ] Deferred `admin` is refused outright, or admin-only with a reason and a ≤14-day expiry.
- [ ] Undo an import in which some pending grants were **already claimed** → the claimed roles are reversed too. Undo that only deletes unclaimed rows reports success while leaving live privilege in place.
- [ ] Undo skips users changed since the import (`DIVERGED_SINCE_IMPORT`) rather than overwriting a later deliberate change.
- [ ] As `JCRC`, a preview containing an admin target returns that row as `denied` **without enumerating the admin's role set**. `previewBulkImport` accepts up to 1000 operator-supplied identifiers and returns `rolesBefore` for each — an unbounded directory-export primitive if unredacted.

---

## 10. Phase 3 — dashboard

### Route and capability guards

- [ ] `RESIDENT` → `/admin` redirects to `/`; **view-source contains no admin markup** (confirms the guard ran server-side, not in a client effect).
- [ ] `RESIDENT` → no Admin link in desktop or mobile nav.
- [ ] `JCRC` → `/admin` renders. Under D-2 this is the **same page** as admin's, with a reduced capability set — not a second variant.
- [ ] Capabilities come from one server-computed object (`whoAmI().capabilities`). `grep -rn "isAdmin ?" src/app/admin/` returns nothing: there is no client-side `isAdmin` fork deciding what renders.
- [ ] As `JCRC`, `getStats` returns `admins: null` and the Admins card is absent.
- [ ] As `JCRC`, the audit feed is absent.
- [ ] As `JCRC`, `systemHealth` returns **aggregate counts only**. The per-user ineligible list, canonical-id collisions and `passwordHash`-missing rows are admin-only — they are account-integrity data about named individuals, and D-2/D-3 keep jcrc below admin.
- [ ] `NOMATRIC` is bounced to `/onboarding/matric` (expected, not a bug — and distinct from the `RESIDENT` redirect above).

### Data hygiene

- [ ] `listUsers` response in the Network tab contains **no** `passwordHash`. Inspect it; do not assume.
- [ ] Search by name and email returns expected results, debounced.
- [ ] Role filter returns the right set, including users whose row is still legacy-shaped.
- [ ] "Load more" advances without duplicating or skipping rows.
- [ ] A user whose `User.userID` differs from their canonical id shows the amber mismatch icon.
- [ ] All five empty/loading/error states render (force each).

### Dialogs

- [ ] As `JCRC` opening an `ADMIN` target: read-only with the explanatory alert.
- [ ] As `JCRC` on a normal target: the `admin` option is **absent**, not rendered-disabled. Do not leak the shape of the privilege ladder.
- [ ] As `JCRC`, both granting and revoking `jcrc` on another user are disabled, with copy that covers **both** directions (v1's tooltip covered removal only).
- [ ] `resident` appears as a read-only badge with no control.
- [ ] Save is disabled while pending; double-clicking produces one mutation.
- [ ] A forced error shows inline and the dialog stays open with input intact.

### Bulk UI

Paste the nine dirty cases: valid E-id · nonexistent E-id · lowercase E-id · A-format matric matching one user · A-format matric matching two · a name matching one · a name matching two · an `@gmail.com` address · a duplicate of an earlier row.
- [ ] Each lands in the right bucket: grant / pending / normalised-grant / resolved / **ambiguous** / needs-confirm / ambiguous / unresolved-NON_NUS / duplicate.
- [ ] Name-matched rows are **unchecked by default** and require an explicit per-row confirm.
- [ ] The name-match gate is enforced server-side, not only by the checkbox. Post directly to the commit endpoint with `confirmed: true` on a name-matched row and confirm the server still refuses — a client-asserted boolean is not a gate (I-7).
- [ ] Committing reports per-id results, not all-or-nothing.
- [ ] All rows share one `batchId`.

### Audit log

- [ ] Contains every mutation from this session, newest first.
- [ ] Denied attempts render distinctly.
- [ ] Pagination returns full pages with a working cursor.
- [ ] No delete or edit control exists anywhere on the page.

---

## 11. Phase 4 — profile

Covered by doc 04's own "Done when". The four that must not be skipped:

- [ ] Save a profile change and inspect the response body — no `passwordHash`.
- [ ] `call("user.updateUserData", { displayName:"x", bio:"", telegramHandle:"", block:5, roles:["admin"], userID:"E0000001" })` → succeeds, but `db.UserRole` for the caller is unchanged and `User.userID` is untouched.
- [ ] `RoleBadges` renders `resident` as **"Resident"**, and the zero-roles fallback is changed. Under v1 "Resident" was the label for *no roles*; under D-1 zero roles means "cannot book anything", and a badge reading "Resident" would tell a locked-out user they are fine. This matters more under a stored baseline than it did under derivation: zero roles is now a **reachable** state (the L-6 residual), not an impossible one, so the fallback is a live code path rather than dead defensive text.
- [ ] **[NOT-ADMIN]** A brand-new signup with no `UserRole` row loads `/profile` and sees a Resident badge — **and** `db.UserRole.findOne` for them now exists holding `"resident"`. Same page load, both halves. The badge alone is exactly the false reassurance the previous bullet is about.
- [ ] As `ADMIN`, `/profile` shows **both** an Admin badge and a Resident badge. Roles stack; the floor is not replaced by the privileged role. A profile that shows only "Admin" is either a render filter (cosmetic) or a persona set up without the baseline (a real defect) — check the stored row to tell which.

---

## 12. Phase 6 — legacy cutover

Full procedure and go/no-go checklist live in `06-legacy-cutover.md`. The verification-side gates, restated because they are the ones that get skipped:

- [ ] `verify-legacy-drop.mjs` exits **0**, run **while the dual-write is still deployed**. The containment check is meaningless afterwards — a legitimately-edited document then carries a stale-but-harmless scalar and the gate reports false failures.
- [ ] The gate is **containment**, not equality: `role == null OR role ∈ roles`. Equality fails on every resident-only row by construction and would stall the cutover indefinitely.
- [ ] v1's presence check (`{ roles: { $exists: false } }`) is **replaced**. It passes on a document with `roles: []` and `role: "admin"` — exactly the document whose scalar must not be dropped.
- [ ] `FacilityAccess.requiredRole` is never `"resident"`; that value inverts a normal room into a lockout under a revert. Unchanged by the stored-baseline revision — the facility-side mirror is not touched.
- [ ] **`ensureBaseline`'s `$setOnInsert: { role: "" }` is removed in the same commit that drops the scalar.** It is a permanent hot-path writer, not a migration-window one, so left in place it resurrects the dropped field on every repair and defeats doc 06's containment gate. Add `db.UserRole.countDocuments({ role: { $exists: true } })` to the post-cutover zero-count assertion, and re-check it at 24h and 72h — one self-heal is all it takes.
- [ ] A backup exists, taken **within the last hour**, and `restore-legacy-scalars.mjs` has been **dry-run against it** and its output inspected. An untested restore is not a restore.
- [ ] The restore reconstructs the scalar from the **live** `roles[]`, not from the snapshot's scalar. Restoring a snapshot value re-grants privilege that was legitimately revoked after the snapshot was taken — the recovery procedure would itself be an escalation vector, run under time pressure.
- [ ] A phase-2 revert keeps `role String?` / `requiredRole String?`. Reverting `prisma/schema.prisma` wholesale restores the *required* declaration, and every resident-only row then throws on read.
- [ ] The 5b deploy (legacy writes removed) is **live on Vercel Production**, not merely merged. A merged-but-unpromoted build is still dual-writing, and any dashboard edit after the `$unset` re-creates the field.
- [ ] Post-drop counts are `0` / `0`, re-checked at **24h and 72h**. A writer that survives 5b will not show up in the count taken one millisecond after the `$unset`.
- [ ] **[NOT-ADMIN]** Post-drop smoke: `RESIDENT` logs in and books a normal room.

---

## 13. Phase 7 — CCA

Full design in `07-cca-future.md`. Verification-side:

- [ ] Both CH-1 drift detectors return **0**: no user holds the `cca_head` string without a `CcaHead` row, and no `CcaHead` row exists for a user lacking the string.
- [ ] A third detector returns 0: no `CcaHead` row references a `ccaID` with no `CCA` document (orphaned by `deleteCcaCascade`, which does not clean up `CcaHead`).
- [ ] `db.CcaHead.countDocuments({ userID: { $not: /^[A-Z0-9._%-]+$/ } })` is **0** (I-1 in a brand-new collection nothing else validates). **Not** an E-format check — `G.S_SAMUEL` is a legitimate canonical key; asserting `/^E\d{7}$/` here is lockout mode L-27 (`00-overview.md` §2.4).
- [ ] Granting `cca_head` to a user with **no `UserRole` row** leaves them booking normal rooms afterwards, **and the created row contains `"resident"`**. Under derived-resident this was automatic and the check was belt-and-braces; under a stored baseline it is the primary assertion, because a create-branch payload of `roles: ["cca_head"]` now produces a genuinely baseline-less row that only the next session read will repair.
- [ ] Re-granting `cca_head` to a user who already heads another CCA does not duplicate the string in `roles`. Prisma Mongo `push` does not dedupe; a duplicate makes any set-payload round trip register a phantom removal.
- [ ] `deleteUserCascade` and `deleteCcaCascade` clean up `CcaHead` and `UserRole`. Without it, a deleted user's grants survive and are re-inherited by anyone later landing on the same canonical userID — escalation reachable with zero privilege.

---

## 14. Rollback

| Stopped after | Rollback |
|---|---|
| Phase A (audit) | Nothing written. |
| Gate 3 (`role String?`) | Revert the schema line and `db push`. No documents were touched. |
| Doc 01 `db push` | Nothing to undo. Optional fields and empty collections are inert. |
| Doc 01 seed | Restore `UserRole` / `FacilityAccess` from `backups/roles-v2-pre-backfill.json`. The backfill only `$set` new fields; the legacy scalar was never modified destructively. |
| Resident backfill | **Nothing to undo, and undoing it would be the lockout.** The rows are now authoritative: stripping `resident` from ~515 users denies every one of them on every normal room until their next page load repairs them one at a time. There is no rollback for this step — only re-running it. |
| D-7 sign-in guard | Revert the deploy. Any `AuthAllowlist` rows are inert without it. |
| Phase 2 (code deploy, flag `off`) | **Set the flag to `off` first, then revert the deploy.** The dual-write kept `role` valid and correct (highest-privilege, not `roles[0]`), so the old single-role `access.ts` works immediately. This is the window the dual-write buys — **but note it is a rollback of D-1's default-deny too**, not a partial one. Once `resident` exists the mirror is no longer a complete representation of role state. |
| Phase 2, enforcement flipped | `node scripts/remediation/set-enforcement.mjs off`. **One command, no deploy, live in 15s.** This is the whole point of §8, and it is the first thing to try before considering a code revert. |
| Phase 3 (dashboard) | Revert the deploy. The route disappears; the router is inert without it. Role data unaffected. |
| Phase 4 (profile) | Revert the deploy. **Keep step 1's `select` fix** — it has no dependencies and reverting it re-opens a live credential leak. |
| Phase 6 (`$unset`) | **No cheap rollback.** `restore-legacy-scalars.mjs`, reconstructing from live `roles[]`, after re-adding the nullable schema fields and `db push`. Documents created after the snapshot have no scalar and are not restored. Do not take this step until §12's gates are all green. |
| Phase 7 (CCA) | Revert the deploy. `CcaHead` rows are inert while nothing consults them; the flat `cca_head` string continues to work. |

`RoleAuditLog` is append-only and never rolled back — it is the forensic record if a rollback goes wrong, and the plan's stated worst-case recovery is reconstructing the role graph from it. **Include it in every backup**; it is currently in none.

### Break-glass: zero admins

No in-app recovery, by design. From a machine with `DATABASE_URL`:

```bash
ADMIN_USER_ID=E1633673 APPLY=yes node scripts/remediation/seed-roles-v2.mjs
```

Additive, so safe at any time and it will not disturb other roles.

### Break-glass: everyone is locked out of booking

In order, stopping as soon as booking works:

1. `node scripts/remediation/set-enforcement.mjs off` — 15s, no deploy. Covers every enforcement-path cause.
2. If that does not fix it, the cause is upstream of enforcement: check `MATRIC_REQUIRED` (a `UserMatric` problem, not a role problem) and the canonical-key derivation (`verify-canonical-rekey.mjs`).
3. Only then consider reverting the Phase 2 deploy.

---

## 15. Follow-ups explicitly out of scope

Recorded so they are not silently lost. Items 1 and 8 were out of scope in v1 and are now **in** scope; the rest remain out.

- ~~Wire the booking picker to a permission-aware query~~ — **now mandatory** (§6.2), not a follow-up.
- ~~Decide D-7~~ — **resolved and shipped** (§4).
- `suspended` / any affirmative sanction. Cut from this revision. **And note what the stored baseline does NOT give you:** removing `resident` is not a sanction. I-8b repairs it at the target's next page load, so a "revoke resident" ban silently lapses within one request — the worst possible failure mode for a disciplinary control. Verify this rather than assuming it: **[NOT-ADMIN]** delete a user's `resident` by hand, have them load a page, confirm it is back. (Scope the claim honestly: self-heal defeats revocation performed through the application's own write paths and through a one-off manual edit, and it makes accidental removal self-correcting. It is **not** a control against an actor with database write access, who can equally write `SystemFlag`, delete the `User` row, or set a `FacilityAccess.requiredRoles` nobody can satisfy.) If a booking ban is ever wanted it is a separate affirmative flag in a **new** collection (`BookingBan { userID @unique, reason, bannedBy, at, expiresAt? }`), checked in `evaluateBooking` **before** the admin bypass, subtracting all capabilities rather than only the baseline, with its own admin-only mutation, its own audit action and a confirmation dialog. It must never be expressed as the absence of `resident`, and `resident` must never become expressible in a mutation payload to enable it — that would re-open the whole set-payload / bulk / undo strip class against a 515-user population to buy a feature nobody asked for.
- Self-serve, head-initiated CCA handover. Requires object-scoped authorization, which the G1–G7 firewall does not have, and has zero day-one users because `CcaHead` starts empty.
- Per-CCA scoping of `cca_head` for booking. The data is stored from day one (`CcaHead`); the single function that would start consulting it is `canBookWithRoles` in `src/server/api/services/access.ts`.
- Verify `ccaID` membership in `createBooking`. The existence half (`ccaID === 0 || CCA exists`) is cheap and non-behaviour-changing; the membership half is not.
- Gate `forceBook` behind `admin || jcrc` (`facilitiesBooking.ts:304`, an unguarded client boolean).
- Authorize the `userId` filter on `getBookings` — any authenticated user can currently enumerate another user's bookings.
- Gate `Posts.isOfficial` behind `jcrc` or `admin`.
- Remove the Google provider entirely (`auth.ts:54-61`). No UI exposes it; it is the only source of `passwordHash`-less rows. Keep the `signIn` callback regardless.
- Rate-limit `previewBulkImport` — it builds a full identity index from operator-supplied input.
- Partial case-insensitive unique index on `User.telegramHandle`, after normalisation reports zero duplicates.

---

## Done when

**Gates — none of the rest counts until these pass**
- [ ] Gate 1: zero canonical re-key orphans across `UserMatric`, `UserRole`, `Bookings`, `UserCCA`.
- [ ] Gate 2: zero `User` rows missing `passwordHash`, or the field is nullable.
- [ ] Gate 3: `role String?` and `requiredRole String?` in the schema **before** any backfill ran.
- [ ] `rbac-doctor.mjs` exits 0 with every line green except `enforcement mode`.

**V-1 — no lockout** (now by mechanism, not by construction; L-6 is the acknowledged exception)
- [ ] **[NOT-ADMIN]** `RESIDENT` books a normal room in `off`, in `permissive`, and in `enforce`.
- [ ] **[NOT-ADMIN]** `RESIDENT`'s `UserRole` row is **deleted by hand**, they load one page, **the row comes back**, and they book (§7 step 3). Self-heal, not derivation, is what makes the backfill non-authoritative for any individual user.
- [ ] Every persona holds `"resident"` in the **stored** row, `ADMIN` included (§1).
- [ ] All three grant points verified from the database, before the created account has loaded a page: register route, `events.createUser`, merge/dedupe scripts (§6.0).
- [ ] `backfill-resident.mjs` re-run immediately before the `enforce` flip prints `MISSING 0`, `modified 0`, `upserted 0` and exits 0 (§7 step 3b).
- [ ] The stored `"resident"` survives, checked in the document and not in the response: `setUserRoles` replace-mode, bulk import `set`-mode, bulk undo, deferred-grant redemption, and the `grantCcaHead` create branch (§7 step 4).
- [ ] **[NOT-ADMIN]** A non-E-format `@u.nus.edu` localpart books a normal room, and its backfill eligibility was decided by `isResidentEligible`, never by `/^E\d{7}$/`.
- [ ] **[NOT-ADMIN]** A brand-new signup books a normal room on their first session.
- [ ] A grant/revoke round trip through the dashboard does not remove anyone's ability to book.
- [ ] `resident` is not expressible in `roleSchema`; the attempt is a zod BAD_REQUEST. It is likewise absent from `GRANTABLE_ROLES`, `ASSIGNABLE_BY` and `REVOCABLE_FROM_OTHERS_BY`, so it cannot enter a removal set in either direction (I-8e).
- [ ] The L-6 detectors fire when the repair write fails: `{"evt":"baseline_repair_failed"}` in the log, the gap on `/admin`'s health panel, and the offending id in the standing query. A repair that fails must never report success — verify the reply's `writeErrors` are inspected, not only the exception path.
- [ ] A session whose canonical id is `""` resolves to zero roles even with a `""`-keyed `UserRole` row planted, and `countDocuments({ userID: "" })` is 0.
- [ ] Every `facilityID` classified, and the gated set exactly equals `facility-roles.json`.
- [ ] 72h of `permissive` with **zero** `NOT_RESIDENT` shadow denials, spanning a weekday and a weekend.
- [ ] `MATRIC_REQUIRED` is textually distinct from every role denial.

**V-2 — no escalation**
- [ ] Every §9.1 line denied **and** audited `ok: false`.
- [ ] `CANNOT_GRANT_JCRC` denied for a jcrc (D-3, reversing v1).
- [ ] A forged `session.user.roles` claiming admin grants nothing (I-5).
- [ ] Denial audit rows survive their guard's transaction rollback.
- [ ] Last-admin and self-revoke guards hold; `count({roles:"admin"})` never reaches 0.
- [ ] No `AuthAllowlist.pinnedUserID` collides with any `canonicalUserID(User.email)`.
- [ ] A pending grant created by a since-demoted granter is dropped at redemption, and the drop is audited.
- [ ] Pending grants are keyed only on canonical E-format ids derived from `@u.nus.edu` addresses.
- [ ] Undo reverses **claimed** deferred grants, not only unclaimed rows.
- [ ] `cca_head` is unreachable through the generic grant path; both CH-1 drift detectors return 0.
- [ ] A cca_head cannot name themselves as a handover target.
- [ ] `grep -rn "getUserRole\b" src/` returns nothing (I-6).

**Operational**
- [ ] The kill-switch drill (§8) ran end to end in `permissive`, including cache-TTL timing, multi-instance convergence, missing-row fallback and DB-failure fail-open.
- [ ] Revert measured at **≤15s with no redeploy**.
- [ ] The revert command and out-of-hours `DATABASE_URL` holder are on the runbook card.
- [ ] `scripts/remediation/backups/` gitignored; no dump in git history.
- [ ] `RoleAuditLog` included in every backup.
- [ ] The standing detection query (§7) is scoped to eligible NUS accounts, returns userIDs rather than a count, is reviewed daily, and is treated as a **red line** — non-empty means a live lockout and blocks the `enforce` flip. `rbac-doctor.mjs` carries the same check at the same severity.
- [ ] Every consumer of `UserRole` outside the Next.js session path (droplet Python backends, bots, cron, scripts) is enumerated, and each either calls the same idempotent top-up or treats a missing baseline as unknown rather than denied (§6.1 scope boundary).
- [ ] Each phase's own "Done when" checklist passes (docs 01, 02, 03, 04, 06, 07).
