**Prerequisite:** doc `01-data-model.md` complete **including its VERIFY checks**, and specifically including the step that relaxes `UserRole.role` and `FacilityAccess.requiredRole` to `String?`. Deploying this code against un-backfilled data violates invariant I-3; deploying it against *required* legacy scalars violates I-2 and hard-breaks login. Both are blocking gates, restated in step 0.

This phase ships **behaviourally inert**. Every user-visible change is behind a data flag (`SystemFlag`) that is `off` at deploy time, except two: the `@u.nus.edu` sign-in restriction (D-7) and the booking picker rendering gated rooms as disabled. Everything else — default-deny booking, the `resident` requirement — turns on later by editing one database row, with no redeploy.

---

## 0. Decisions this document encodes, and the ones it overturns

| Ref | Binding decision | Effect here |
|---|---|---|
| D-1 | Booking is role-driven; `resident` baseline; normal rooms require `["resident"]` | §3 default-deny; §2 `resident` grant + self-heal |
| D-2 | ONE `/admin`, capability set computed server-side | §7 `capabilities.ts`; no `isAdmin` fork anywhere |
| D-3 | a jcrc may **not** grant `jcrc` | §6 `ASSIGNABLE_BY.jcrc = ["cca_head"]` |
| D-6 | full transition; legacy scalars dropped | §4 keeps the read fallback + dual-write **for this phase only**; removal is doc `06-legacy-cutover.md` |
| D-7 | sign-in restricted to `@u.nus.edu` | §2 `signIn` callback, credentials path, register route |
| D-8 | bulk everything + deferred grants | §8 bulk procedures; §2.5 redemption hook |

### 0.1 Two v1 positions this document reverses, and why

**`resident` is STORED, auto-assigned and self-healing.** (This reverses the earlier v2 position that `resident` was *derived*; invariant I-8 in `00-overview.md` §2.3 has been repealed and replaced by I-8a/I-8b/I-8c/I-8d/I-8e. Read those before touching anything in this document.) v1 had no baseline role. `resident` is now a real value in `UserRole.roles`, held by **every** sign-in-eligible identity including admins, jcrc and cca_head — roles stack, and `resident` is the floor, never an alternative. Authorization reads the stored value; nothing re-derives it.

The naive stored implementation has ~18 distinct ways to leave a legitimate user unable to book (mis-keyed backfill, partial backfill, a set-payload that omits it, a read-boundary filter stripping it, a jcrc revoking it, a failed write in the session callback). Three mechanisms — and only these three — close them:

- **I-8a grant at creation** (§2.6): every path that creates a `User` document ensures the baseline in the same request.
- **I-8b self-heal at session read** (§2.4/§2.5): a missing baseline repairs itself, idempotently and race-safely, *before* any role is consumed.
- **I-8c sticky at every write** (§6): `resident` is not filtered out of a removal payload — it is **incapable of entering one**, because every role write is `$pull(removed)` + `$addToSet(added)` with `removed ⊆ GRANTABLE_ROLES`, and `resident` is not in that list.

The property that makes this safe, and on which every "closed" claim rests: **every authoritative role check in this application is preceded, in the same request, by a run of the NextAuth `session` callback** (`src/server/api/trpc.ts:30` calls `await auth()` on every tRPC request; `auth()` is `getServerSession`, which runs `callbacks.session` every time under the JWT strategy — there is no server-side session cache). A repair placed inside that callback therefore runs *before use*. `isResidentEligible()` is no longer an authorization input; it is a **write guard** — it decides who may *receive* the baseline, never who *has* it.

The one honest residual: a write failure scoped to `UserRole` while writes elsewhere succeed. It is mitigated (retry, repair-on-deny at book time) and **detected** (`baseline_repair_failed` structured log → `admin.systemHealth` → the daily doctor query), not closed. See §2.5.

Consequence to sign off on: `resident` remains not revocable as an ordinary role. Nothing in `setUserRoles`, bulk import, bulk undo or deferred-grant redemption can express or remove it. **And a manual database revocation is not a sanction either** — I-8b repairs it at the target's next page load. If a per-user booking ban is ever needed it is a new affirmative `BookingBan` collection with its own mutation, its own audit action and its own confirmation, checked in `evaluateBooking` *before* the admin bypass — **explicitly out of scope for this phase**; do not invent one here, and specifically do not build it as "remove `resident`", which silently lapses.

**Missing `FacilityAccess` row means `["resident"]`, not deny-all.** Three candidate semantics for an unconfigured facility: open-to-all (today's — silently world-bookable), deny-all (a new normal room is unbookable by everyone including its creator, until someone notices), or `["resident"]`. The third makes the common case correct by default and bounds the failure of the rare case to authenticated hall residents rather than the world. Under the stored baseline its lockout path is **no longer empty** — a user whose baseline write failed or was never backfilled is denied on every *normal* room, not just gated ones — but that path is closed by I-8b (repair before read), not by semantics. (`00-overview.md` §2.6 and I-10 carry the same correction.) The residual exposure — a newly created *gated* room is resident-bookable until configured — is closed operationally by the `unconfiguredFacilities` count in `admin.systemHealth` (§7.4).

### 0.2 Blocking gates before any code in this document is written

1. `prisma/schema.prisma` line ~247 reads `role String?` and line ~255 reads `requiredRole String?`. **If either is still required, stop.** Every write in §2.4/§2.5/§2.6 and doc 01's resident backfill creates documents without them, and Prisma 6's Mongo connector throws on read — inside the session callback, i.e. nobody can log in. **This gate is doubly non-negotiable under the stored baseline:** the backfill is now authoritative and `ensureBaseline` is a permanent hot-path *writer*, so far more `UserRole` documents get created than under the derived design, each of which must carry the I-9 sentinel `$setOnInsert: { role: "" }` — empty string, not `null`, not `"user"`. Doctor line `UserRole rows missing the legacy scalar` must read 0.
2. `node scripts/remediation/verify-canonical-rekey.mjs` prints **zero orphans** across `UserMatric.userID`, `UserRole.userID`, `Bookings.userID`, `UserCCA.userID`. §2.1 changes the derivation from an unanchored `.replace()` to an anchored regex with `.trim()`; any user whose stored email is not exactly `X@u.nus.edu` (whitespace, `+tag`, `u.nus.edu.sg`) gets a *different* key and silently loses their matric row **and every booking they own**. Re-key them first.
3. `db.$runCommandRaw({ count: "User", query: { passwordHash: { $exists: false } } })` returns **0**, or `User.passwordHash` has been made `String?`. Otherwise the third session lookup in §2.4 throws for Google-adapter rows and logs those users out. If the count is non-zero and you do not want to touch `passwordHash`, drop the `displayName` lookup instead and tell doc `04-profile-page.md`.
4. The non-`@u.nus.edu` `User` list has been triaged with the user (correct the address, merge, or accept the block). Run: `db.$runCommandRaw({ find: "User", filter: { email: { $not: /^[A-Za-z0-9._%-]+@u\.nus\.edu$/i } }, projection: { email: 1, userID: 1, displayName: 1 }, limit: 500 })`. **If your own admin account is in that list, D-7 bricks the deployment.** D-4 confirms `E1633673`, so this is unlikely — verify, do not assume.

---

## 1. File map

| Path | Status | Contains |
|---|---|---|
| `src/lib/identity.ts` | **new** | pure email→canonical-userID + NUS domain predicate. No Prisma, no `env`. Client-importable. |
| `src/server/api/services/roles.ts` | **new** | role vocabulary, `ASSIGNABLE_BY`, `normalizeStoredRoles`, `STICKY` |
| `src/server/api/services/flags.ts` | **new** | `SystemFlag` kill switch |
| `src/server/api/services/baseline.ts` | **new** | **authoritative** `resident` self-heal (`ensureBaseline`) + pending-grant redemption |
| `src/server/api/services/capabilities.ts` | **new** | D-2 server-computed capability set |
| `src/server/api/services/access.ts` | **rewrite** | policy: `getUserRoles`, `evaluateBooking` |
| `src/server/api/services/roleService.ts` | **new** | escalation guards + audit |
| `src/server/api/routers/admin.ts` | **new** | admin/roles router |
| `src/server/auth.ts` | edit | `signIn` guard, session roles + **I-8b self-heal**, **new `events.createUser` baseline grant (I-8a)**, redirect fix, type augmentation |
| `src/server/api/trpc.ts` | edit | eligibility check, `requireRoles`, `adminProcedure`, `roleManagerProcedure` |
| `src/server/api/routers/facilitiesBooking.ts` | edit | 4 call sites + `getFacilitiesForBooking` |
| `src/app/api/register/route.ts` | edit | D-7 + **baseline grant (I-8a)** |
| `src/app/api/reset-password/request-verification-code/route.ts` | edit | D-7 (third copy of the domain rule) |
| `src/env.js` | edit | `RBAC_BOOKING_ENFORCEMENT`, `AUTH_EMAIL_ALLOWLIST` |

`src/lib/identity.ts` deliberately sits in `src/lib/` beside `password.ts` and `rateLimit.ts`, **not** in `src/server/`. `src/app/login/page.tsx` imports it (doc 03), and a `~/server/*` import from a `"use client"` file works only by accident of the module happening to be pure. Add an eslint `no-restricted-imports` rule forbidding `~/server/db` and `~/env` from this file.

---

## 2. Identity, sign-in restriction (D-7), and the session

### Step 2.1 — `src/lib/identity.ts` (new)

```ts
/**
 * THE canonical identity rules. Every domain check and every role-key
 * derivation in this codebase comes from this file. Decision D-7 + invariant I-1.
 *
 * The sign-in gate and the role key are derived from the same string, in the
 * same module, on purpose: if they could drift, an account could pass the gate
 * and then be keyed under an id no backfill ever wrote (or vice versa).
 *
 * PURE. No Prisma, no `env`, no `next/server` — it is imported by client
 * components. Keep it that way.
 */

/**
 * Anchored, ASCII-only. Each property is load-bearing:
 *   ^...$        rejects bob@u.nus.edu.evil.com
 *   single @     rejects bob@evil.com@u.nus.edu
 *   [A-Z0-9._%-] ASCII only, so a Cyrillic-е homograph domain cannot match
 *   NO '+'       e1234567+x@u.nus.edu would canonicalise to a DIFFERENT key for
 *                the same human — a duplicate-account vector. Gate 0.2(2) must
 *                confirm no plus-addressed account exists before shipping this.
 */
const NUS_STUDENT_EMAIL = /^([A-Z0-9._%-]+)@U\.NUS\.EDU$/;

/** `.trim()` is load-bearing: auth.ts historically omitted it. See gate 0.2(2). */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function isNusStudentEmail(email: string | null | undefined): boolean {
  return NUS_STUDENT_EMAIL.test(normalizeEmail(email).toUpperCase());
}

/**
 * Returns "" for anything that is not a valid @u.nus.edu address.
 *
 * This is a BEHAVIOUR CHANGE from src/server/auth.ts:135-137, which used an
 * unanchored .replace() and returned e.g. "ALICE@GMAIL.COM" — a garbage-but-
 * truthy string that was then usable as a role key. Returning "" makes
 * `canonicalUserID(e) !== ""` exactly equivalent to `isNusStudentEmail(e)`, so
 * the sign-in gate and the role key cannot disagree.
 *
 * NOTE: the localpart is NOT required to be E-format. `g.s_samuel@u.nus.edu`
 * exists in this database and canonicalises to "G.S_SAMUEL". Never gate
 * eligibility or the resident baseline on /^E\d{7}$/ — that is a real lockout.
 * E_FORMAT is a validation rule for GRANT TARGETS only (§6 G7). Under the
 * STORED baseline the blast radius of getting this wrong has increased: the
 * same predicate now gates the WRITE, so an E-format test here withholds the
 * baseline permanently rather than mis-deriving it once.
 */
export function canonicalUserID(email: string | null | undefined): string {
  const m = NUS_STUDENT_EMAIL.exec(normalizeEmail(email).toUpperCase());
  return m ? m[1]! : "";
}

/** Rendered by /login. */
export const AUTH_ERROR = { NOT_NUS_EMAIL: "NotNusEmail" } as const;
```

`scripts/remediation/` cannot import TypeScript. Mirror this file **verbatim** to `scripts/remediation/lib/identity.mjs` with a header naming the source of truth, and add a parity test (doc `05-verification.md`) asserting identical output over: `e1234567@u.nus.edu`, `E1234567@U.NUS.EDU`, `"  e1234567@u.nus.edu  "`, `g.s_samuel@u.nus.edu`, `bob@u.nus.edu.evil.com`, `bob@evil.com@u.nus.edu`, `bob@sub.u.nus.edu`, `bob@nus.edu.sg`, `e1234567+x@u.nus.edu`, `""`, `null`.

**Domain verdicts, stated so nobody re-litigates them mid-implementation:**

| Address | Verdict |
|---|---|
| `e1234567@u.nus.edu`, `g.s_samuel@u.nus.edu` | allow |
| `E1234567@U.NUS.EDU` | allow — **this is a live bug fix**, `register/route.ts:51` rejects it today |
| `bob@u.nus.edu.evil.com`, `bob@evil.com@u.nus.edu`, `bob@sub.u.nus.edu` | reject |
| `bob@nus.edu.sg` (staff) | **reject.** `@nus.edu.sg` is the whole university, not Raffles Hall; a staff address has no E-localpart to canonicalise; and under D-1 admitting a domain now means auto-granting hall booking rights to it. Admit individuals via the break-glass allowlist below. |
| `e1234567+tag@u.nus.edu` | reject — see the regex comment |

**Break-glass allowlist.** `AUTH_EMAIL_ALLOWLIST` (comma-separated, lowercased emails) in `src/env.js` permits **sign-in only**. It does not pin, re-key, or grant anything: an allowlisted non-NUS account still has `canonicalUserID === ""`, so it receives no stored baseline (I-8d), holds no roles and cannot book. **This env-var form is the variant that ships** — `00-overview.md` §2.4, `01-data-model.md` and `05-verification.md` describe an alternative `AuthAllowlist` collection with a `pinnedUserID`; those references are stale against this section and must be reconciled to the env-var form. If a pinned form is ever revived, an `EXT:`-namespaced id must be **explicitly excluded** from the baseline write: `isResidentEligible("EXT:ALICE")` returns `true` (non-empty, no `@`), so the shape test alone would grant a stored baseline to a non-NUS principal on its first page load. That is why §3.1's guard is documented as a post-canonicalization sanity check and why `ensureBaseline` canonicalizes the **email** internally rather than trusting a caller-supplied id (§2.5). It exists so a mistaken hard block is recoverable without a schema change. Deliberately **not** a database collection with a `pinnedUserID` column — that field would be an unconstrained account-takeover primitive (write `{email: attacker@…, pinnedUserID: "E1633673"}` and inherit admin wholesale, bypassing every guard in §6). If a durable exception mechanism is ever needed, it is designed in doc `07-cca-future.md`, admin-only, with a namespaced non-collidable key.

### Step 2.2 — `src/env.js`

```diff
     BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
+    /**
+     * DEPLOY-LEVEL DEFAULT ONLY. The live switch is the SystemFlag row — Vercel
+     * snapshots env vars per deployment, so editing this in the dashboard
+     * requires a redeploy and is therefore NOT a kill switch. See §3.4.
+     */
+    RBAC_BOOKING_ENFORCEMENT: z
+      .enum(["off", "permissive", "enforce"])
+      .default("off"),
+    /** Break-glass D-7 exception list. Sign-in only; confers no roles. */
+    AUTH_EMAIL_ALLOWLIST: z.string().optional(),
   },
```

and the matching two lines in `runtimeEnv`.

### Step 2.3 — `src/server/auth.ts`: the D-7 guard

Two provider paths, plus a fix to an existing callback that would otherwise swallow the denial.

```diff
 import { verifyPassword } from "~/lib/password";
+import { canonicalUserID, isNusStudentEmail, normalizeEmail } from "~/lib/identity";
+import { normalizeStoredRoles, BASELINE_ROLE } from "~/server/api/services/roles";
+import { ensureBaseline, redeemPendingGrants } from "~/server/api/services/baseline";
+
+/** D-7. The ONLY eligibility predicate. Break-glass allowlist is sign-in only. */
+function maySignIn(rawEmail: string | null | undefined): boolean {
+  const email = normalizeEmail(rawEmail);
+  if (!email) return false;
+  if (isNusStudentEmail(email)) return true;
+  const allow = (process.env.AUTH_EMAIL_ALLOWLIST ?? "")
+    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
+  return allow.includes(email);
+}
```

Credentials `authorize` — two gates, on the submitted address and on the stored one:

```diff
         const { email, password } = parsedCredentials.data;
+
+        // D-7 gate #1, before any DB work. Return null (not throw) so the
+        // response shape is identical to a wrong password — this endpoint must
+        // not become an oracle for "which domains are accepted".
+        if (!maySignIn(email)) return null;
+
         const user = await db.user.findFirst({
           where: { email: { mode: "insensitive", equals: email } },
         });
         if (!user?.passwordHash) return null;
+
+        // D-7 gate #2, on the STORED address. The lookup is case-insensitive-
+        // equals, so the stored value can differ from the submitted one, and
+        // only the stored value is used downstream to derive the role key.
+        if (!maySignIn(user.email)) return null;
```

`pages` and the `signIn` / `redirect` callbacks:

```diff
   pages: {
     signIn: "/login",
+    // Without this, a rejected OAuth sign-in lands on NextAuth's unbranded
+    // /api/auth/error. Pointing it at /login means the denial surfaces as
+    // /login?error=AccessDenied, which doc 03 renders.
+    error: "/login",
   },
```

```diff
   callbacks: {
+    /**
+     * D-7. Runs BEFORE PrismaAdapter persists anything on the OAuth path
+     * (next-auth/core/routes/callback.js:78 vs :104), so a rejected Google
+     * account leaves NO User row and NO Account row behind — and therefore
+     * never reaches events.createUser (§2.6 G-B), so no baseline is minted for
+     * an ineligible identity. This callback keeps EXACTLY ONE JOB: return
+     * false for non-NUS. Do not put the baseline grant here (see §2.6).
+     *
+     * Returns `false`, never a redirect string. On the CREDENTIALS branch a
+     * string return yields HTTP 200 with no `status` field
+     * (callback.js:368-371), so signIn(..., {redirect:false}) computes
+     * ok:true on the client while no session cookie was set — a "successful"
+     * login into nothing. `false` gives 403 + ?error=AccessDenied on both
+     * providers, and `pages.error` routes it to /login.
+     */
+    async signIn({ user, account, profile }) {
+      const email = normalizeEmail(user?.email);
+      if (!maySignIn(email)) {
+        // Log the DOMAIN only — never the full address of a denied,
+        // unauthenticated party.
+        console.warn(JSON.stringify({
+          evt: "signin_rejected_domain",
+          provider: account?.provider,
+          domain: email.split("@")[1] ?? "(none)",
+        }));
+        return false;
+      }
+      // OAuth only: an unverified profile email is an unauthenticated claim,
+      // and under D-1 a successful sign-in confers booking capability.
+      if (account?.type === "oauth" &&
+          (profile as { email_verified?: boolean } | undefined)?.email_verified !== true) {
+        return false;
+      }
+      return true;
+    },
     async jwt({ token, user }) {
```

```diff
-    async redirect({ baseUrl }) {
-      return `${baseUrl}/`;
-    },
+    async redirect({ url, baseUrl }) {
+      // The old unconditional form discarded every URL including NextAuth's
+      // own error redirect, so a rejected user was silently bounced to "/".
+      // Same-origin pass-through; anything external still collapses to home.
+      return url.startsWith(baseUrl) ? url : `${baseUrl}/`;
+    },
```

> **Google provider — recommended removal.** `GoogleProvider` is registered at `auth.ts:54-61` but **no UI exposes it**; it is reachable only by navigating directly to `/api/auth/signin/google`. It is also the sole source of `passwordHash`-less `User` rows (gate 0.2(3)) and of `OAuthAccountNotLinked` failures. Deleting lines 54-61 removes an unused attack surface. **Keep the `signIn` callback regardless** — it is the guard for the day the provider returns.

**The guard is prospective only.** `session.maxAge` is 30 days (`auth.ts:119`), and `signIn` does not re-run for a live token. Ineligible legacy sessions are handled in §2.4 (`eligible: false`) and denied server-side in §5, not left to expire.

### Step 2.4 — `src/server/auth.ts`: the session callback

Type augmentation first (without this the phase does not compile):

```diff
     user: {
       id: string;
       userID: string;
-      bio: string;
       matric: string | null;
       hasMatric: boolean;
+      /**
+       * D-7. False only for a pre-cutover JWT on an ineligible address, or a
+       * blank/malformed stored email. RENDER-ONLY — protectedProcedure
+       * re-derives it server-side (§5).
+       */
+      eligible: boolean;
+      /**
+       * Live role list, re-read on every session read (invariant I-4 — never
+       * baked into the 30-day JWT).
+       *
+       * FOR RENDERING ONLY (invariant I-5). Never authorize a mutation off
+       * this value; every privilege-changing procedure re-reads from the DB.
+       */
+      roles: string[];
+      isAdmin: boolean;
     } & DefaultSession["user"];
```

`bio` is removed: it is declared but never populated, so every reader gets `undefined` while the type promises `string`. Also delete the dead `bio: user.bio` from the credentials `authorize` return (~line 108) — the `jwt` callback never copies it.

The callback body, replacing lines 133–154:

```diff
       if (session.user && token.id) {
         session.user.id = token.id as string;
-        const userID = (token.email ?? "").toUpperCase().replace("@U.NUS.EDU", "");
-        session.user.userID = userID;
+        // Anchored derivation, single source of truth. Gate 0.2(2) proves this
+        // re-keys nobody.
+        const userID = canonicalUserID(token.email);
+        session.user.userID = userID;
+        session.user.eligible = userID !== "";
         session.user.email = token.email;
         session.user.name = token.name;
 
-        const record = await db.userMatric.findUnique({ where: { userID } });
-        session.user.matric = record?.matric ?? null;
-        session.user.hasMatric = Boolean(record?.matric);
+        if (!session.user.eligible) {
+          // userID === "" here. Backstop for a JWT minted before the D-7
+          // deploy, or a blank/malformed stored email. Do NOT throw — a
+          // rejected session callback force-logs-out the user, which is an
+          // unrecoverable state. Mark it and let §5 deny authoritatively.
+          //
+          // The early RETURN is load-bearing, not tidiness: without it the
+          // callback would run `userRole.findUnique({ where: { userID: "" } })`,
+          // and if a ""-keyed UserRole row ever exists (I-8d calls one a red
+          // line) EVERY non-canonicalizable principal would inherit its roles
+          // wholesale, including `admin`, with no grant path and therefore no
+          // escalation guard firing. getUserRoles already guards this (§4.3);
+          // the session callback must not be weaker than the read boundary it
+          // feeds. ensureBaseline is likewise skipped entirely.
+          session.user.matric = null;
+          session.user.hasMatric = false;
+          session.user.roles = [];
+          session.user.isAdmin = false;
+          return session;
+        }
+
+        // Parallel indexed lookups — one round-trip of latency.
+        const [matricRow, roleRow, dbUser] = await Promise.all([
+          db.userMatric.findUnique({ where: { userID } }),
+          db.userRole.findUnique({ where: { userID } }),
+          db.user.findUnique({
+            where: { id: token.id as string },
+            select: { displayName: true },
+          }),
+        ]);
+
+        session.user.matric = matricRow?.matric ?? null;
+        session.user.hasMatric = Boolean(matricRow?.matric);
+
+        // Legacy-tolerant read for the D-6 dual-write window. Removing this
+        // fallback belongs to doc 06 — dropping it early silently demotes any
+        // admin/jcrc row the doc-01 backfill missed, and unlike `resident`
+        // those roles have no self-heal path: nothing puts them back.
+        let stored = roleRow?.roles?.length
+          ? roleRow.roles
+          : roleRow?.role ? [roleRow.role] : [];
+
+        // ---- I-8b SELF-HEAL. Cold path only. ----------------------------
+        // In steady state (row exists AND contains "resident") this block is
+        // a single Array.includes() on a <=4-element array and issues NOTHING
+        // — zero extra reads, zero writes. The userRole lookup above was
+        // ALREADY required to read admin/jcrc, which were never derivable, so
+        // self-heal adds no query.
+        //
+        // It is AWAITED, unlike the v2 fire-and-forget materialization, so the
+        // SAME request sees the repaired set. That is sound because this
+        // callback runs before every authoritative check (trpc.ts:30 calls
+        // auth() on every tRPC request): repairing here repairs BEFORE USE.
+        // ensureBaseline never throws, so awaiting it cannot reject the
+        // session.
+        if (!stored.includes(BASELINE_ROLE)) {
+          // Pass the EMAIL, not the id: ensureBaseline canonicalizes
+          // internally so the write cannot be reached without an @u.nus.edu
+          // address having been presented (I-8d, provenance not shape).
+          const healed = await ensureBaseline(db, token.email);
+          if (healed) stored = [...stored, BASELINE_ROLE];
+          // If it did NOT heal we do NOT synthesise the role. The stored value
+          // is the truth (I-8). access.ts retries the repair once more before
+          // denying a booking (§4.3, repair-on-deny).
+        }
+        // ------------------------------------------------------------------
+
+        const roles = normalizeStoredRoles(stored);
+        session.user.roles = roles;
+        session.user.isAdmin = roles.includes("admin");
+
+        // displayName is editable on /profile; without this the JWT-cached
+        // token.name shows the old name for up to 30 days. (doc 04)
+        if (dbUser?.displayName) session.user.name = dbUser.displayName;
+
+        // D-8 pending-grant redemption. Fire and forget — it is not on the
+        // booking path. One-shot: redeemPendingGrants stamps pendingCheckedAt
+        // unconditionally as its final step (INCLUDING the no-grants and
+        // expired cases), so this guard goes false forever after one run and
+        // the steady-state cost really is zero queries. It contains its own
+        // errors AND carries a .catch() here: an unhandled rejection on the
+        // session path is a lambda-level fault on the hottest route in the
+        // app, i.e. a mass availability event, not a single-user one.
+        if (roleRow?.pendingCheckedAt == null) {
+          void redeemPendingGrants(db, userID).catch(() => { /* contained */ });
+        }
       }
```

Add `import { canonicalUserID } from "~/lib/identity";`.

Note what is deliberate here: **in steady state nothing writes and nothing extra is read**; the cold path writes exactly once per user per lifetime (plus once per hand-deletion) and is awaited; and **no promise originated in this callback may reject** — that covers `redeemPendingGrants` and any future addition, not just `ensureBaseline`.

**Against I-4.** None of this puts roles into the JWT. `ensureBaseline` writes to `UserRole`; the role list is still read live from the database on every session read, so a revoked `admin` still loses admin on the next page load. I-4 and I-5 hold verbatim. This is also why the repair belongs here and **not** in `events.signIn`: that fires once per credential presentation, i.e. roughly once per 30 days under `session.maxAge`, and never for a session resumed from an existing JWT — a row deleted by hand on day 3 would not be repaired until day 30.

**Scope boundary (state it, do not assume it).** The repair-before-read guarantee holds only for requests that traverse this callback. Any other consumer of `UserRole` — the droplet Python backends, bots, cron, `scripts/` — sees the *unhealed* stored value, whereas under the derived design there was no unhealed value to see. Such a consumer must either call the same idempotent top-up or treat a missing baseline as **unknown**, never as denied.

**Merge-blocking grep gate (companion to I-8a's).** `grep -rn "getUserRoles\|isAdmin(" src/app/api/ src/server/` — every call site must be reachable only from a context that has run `auth()`, or must call `ensureBaseline` itself. Thirteen lockout modes are re-closed by the chokepoint property alone; an App Router handler that reads roles without `auth()` silently un-closes them.

### Step 2.5 — `src/server/api/services/baseline.ts` (new)

Two exported functions with different guarantees. `ensureBaseline` is **authoritative** (I-8b) and is called from three places: the session callback (§2.4), `evaluateBooking`'s repair-on-deny (§4.3), and the grant points in §2.6. `redeemPendingGrants` is unchanged in purpose and is still fire-and-forget.

```ts
import type { PrismaClient } from "@prisma/client";
import { canonicalUserID } from "~/lib/identity";
import { BASELINE_ROLE, isCanonicalResidentID, isGrantableRole } from "./roles";
import { assignableBy } from "./roles";
import { getUserRoles } from "./access";

/**
 * I-8b. Idempotent, race-safe top-up of the STORED baseline.
 *
 * Returns true if the baseline is (now) present, false if the repair failed.
 * NEVER throws — it is called from the session callback, and an unhandled
 * rejection there rejects the session and force-logs-out the user, which is an
 * unrecoverable state.
 *
 * TAKES THE EMAIL, NOT THE ID (I-8d). The eligibility predicate is a pure
 * SHAPE test with no provenance; it is sound only over a string that
 * canonicalUserID() just produced. Canonicalizing inside means the only way to
 * reach this write is to have presented an @u.nus.edu address. Do not add an
 * id-taking overload "for convenience" — that is how an admin-supplied
 * E-format string becomes a stored baseline for a principal that was never
 * email-verified.
 */
export async function ensureBaseline(
  db: PrismaClient,
  email: string | null | undefined,
): Promise<boolean> {
  const userID = canonicalUserID(email);
  if (!userID || !isCanonicalResidentID(userID)) return false;   // I-8d trust boundary

  // Circuit breaker. A UserRole-scoped write fault (the L-6 residual) would
  // otherwise make EVERY request from EVERY affected user issue 1-2 failing
  // AWAITED writes on the hottest path in the app — a per-user denial
  // amplified into an app-wide latency event. Same shape on a mass cold start
  // (stale-backup restore: ~515 users cold at once). Per-lambda, short TTL,
  // reusing the 15s SystemFlag cache pattern from I-11.
  if (breakerOpen()) return false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `role: ""` on insert satisfies the still-present legacy scalar without
      // polluting doc 06's containment gate. It MUST be the empty string, not
      // null: the still-deployed old client throws on absence AND on null,
      // while "" is falsy and preserves the live access.ts:36
      // `if (!required) return true`. See 01 §0.1 and blocking gate 0.2(1).
      // NOTE: nothing else in this command touches `role`, which is why
      // $setOnInsert is legal here and ILLEGAL in §6 (I-9: $set and
      // $setOnInsert may never name the same path — MongoDB rejects it with
      // ConflictingUpdateOperators).
      const res = (await db.$runCommandRaw({
        update: "UserRole",
        updates: [{
          q: { userID },
          u: { $addToSet: { roles: BASELINE_ROLE }, $setOnInsert: { role: "" } },
          upsert: true,
        }],
        ordered: false,
      })) as {
        ok?: number; n?: number; nModified?: number;
        upserted?: unknown[]; writeErrors?: { code: number }[];
      };

      // INSPECT THE REPLY, DO NOT RELY ON THE EXCEPTION PATH. The MongoDB
      // `update` command does NOT throw on per-write failures: it resolves
      // with { ok: 1, n: 0, writeErrors: [{ code: 11000 | 121 | ... }] }, and
      // Prisma's $runCommandRaw passes that through as DATA (it rejects only
      // on ok:0 or a driver-level fault). Reading only the catch block would
      // (a) make the E11000 retry below dead code, (b) return true for a write
      // that never applied, and (c) never log baseline_repair_failed — which
      // would turn the design's single honest residual from
      // MITIGATED+DETECTED into UNDETECTED.
      const errs = res.writeErrors ?? [];
      if (res.ok === 1 && errs.length === 0) { breakerSuccess(); return true; }

      // E11000: a CONCURRENT upsert inserted the document between our match
      // and our insert. This is NOT unconditionally success. Treating it as
      // success is wrong under a stored baseline: if the winner was a
      // concurrent bulk grant inserting { roles: ["jcrc"] }, our $addToSet
      // never applied and the user has no baseline. Retry once — the document
      // now exists, so the retry MATCHES and $addToSet applies.
      if (attempt === 0 && errs.length > 0 && errs.every((e) => e.code === 11000)) continue;

      breakerFailure();
      console.error(JSON.stringify({
        evt: "baseline_repair_failed", userID, writeErrors: errs,
      }));
      return false;
    } catch (err) {
      // Connection-level / ok:0 faults DO throw. Kept as a secondary path.
      if (attempt === 0) continue;
      breakerFailure();
      console.error(JSON.stringify({ evt: "baseline_repair_failed", userID, err: String(err) }));
      return false;
    }
  }
  breakerFailure();
  return false;
}
```

**The circuit breaker** (`breakerOpen` / `breakerSuccess` / `breakerFailure`) is a module-level, per-lambda-instance guard in the same shape as `flags.ts`'s 15s cache: a `Map<userID, expiry>` negative cache (~30–60s TTL) plus a global consecutive-failure counter that opens for the same window after N failures. It is not a correctness mechanism — it is the thing that stops a `UserRole`-scoped write fault from turning a per-user denial into an app-wide latency event, since without it every request from every affected user would issue 1–2 failing awaited writes plus a `console.error` before the session resolves. The same bound applies to a mass cold start.

**Race properties.** `$addToSet` is idempotent and commutative, so N concurrent session callbacks converge on one document holding one `"resident"` entry. It cannot interleave destructively with `applyRoleChange`, because that writes `$pull`/`$addToSet` too (§6) — after this phase there is **no blind set-payload** anywhere on `UserRole.roles`. (There is still a read-then-write *across statements* in the guard→apply pair; §6 closes that with an explicit compare-and-set, not with the operator choice.)

**Cost on the session path.**

| State | Extra reads vs. the derived design | Extra writes |
|---|---|---|
| Steady state — row exists, contains `resident`, `pendingCheckedAt` stamped (~100% of requests after week 1) | **0** | **0** |
| Cold path (row missing or lacking `resident`) | 0 | 1 upsert, awaited, ~1 Atlas RTT ≈ 40–80 ms |
| Contended cold path (E11000 retry) | 0 | 2 upserts |
| **Repair failing** (L-6) | 0 | 1 attempt per lambda per breaker window, **not** per request |
| **Mass cold start** (stale-backup restore) | 0 | 1 upsert per user, once; breaker bounds the failing case |
| Pending-grant path, unstamped | 1 `PendingRoleGrant` read + 1 granter role read, **once per user ever** | 1 stamp |

The `db.userRole.findUnique` was **already** in the session callback to read `admin`/`jcrc`, which were never derivable. Self-heal therefore adds zero queries in steady state; its whole cost is one `Array.includes()` plus one awaited write per user per lifetime. The derived design's fire-and-forget materialization had the *same* write on the *same* trigger — the only change is `void` → `await`, and only when the guard fires.

```ts
/**
 * Redemption RE-AUTHORIZES at claim time. A grant created while the granter
 * held jcrc must not land if the granter has since been demoted, and a role
 * that has left the vocabulary must not land at all. Expired rows never land.
 *
 * FIRE-AND-FORGET, and therefore SELF-CONTAINING: the whole body is wrapped so
 * it can never reject into the session callback (I-8b covers every promise
 * originated there, not just ensureBaseline).
 *
 * This is the FOURTH role-write surface and the one the §6 chokepoint does not
 * cover. It writes $addToSet ONLY — it never removes anything, so it needs no
 * $pull and cannot strip the baseline (I-8c). The v2 form
 * (`update({ data: { roles: after } })`) was a set-payload computed from a
 * separate `before` read, i.e. a read-modify-write racing the session
 * callback's $addToSet: exactly the I-13 failure.
 */
export async function redeemPendingGrants(db: PrismaClient, userID: string): Promise<void> {
  try {
    const p = await db.pendingRoleGrant.findUnique({ where: { userID } });

    // The stamp is written on EVERY exit path, including no-row and expired.
    // Without that, a user with no pending grants re-queries this collection
    // on every request forever — the "zero extra reads in steady state" claim
    // in §2.4 is false unless the stamp lands unconditionally.
    const stamp = async () => {
      await db.$runCommandRaw({
        update: "UserRole",
        updates: [{ q: { userID }, u: { $set: { pendingCheckedAt: new Date() } } }],
      });
      // $runCommandRaw, not userRole.update: the typed update throws P2025
      // when no row exists, which is precisely the ensureBaseline-failed case
      // this function must survive. A no-op match is the correct behaviour.
    };

    if (!p) { await stamp(); return; }
    if (p.expiresAt <= new Date()) { await stamp(); return; }  // UI shows "expired, never claimed"

    const granterNow = await getUserRoles(db, p.createdBy);
    const stillAllowed = assignableBy(granterNow);
    const granted = p.roles.filter((r) => isGrantableRole(r) && stillAllowed.has(r));
    const dropped = p.roles.filter((r) => !granted.includes(r));

    const before = await getUserRoles(db, userID);
    const after = [...new Set([...before, ...granted])];

    if (granted.length) {
      await db.$runCommandRaw({
        update: "UserRole",
        updates: [{
          q: { userID },
          // Additive only. No $pull, no set-payload, no `after` written back.
          u: { $addToSet: { roles: { $each: granted } } },
        }],
      });
    }
    await db.$transaction(async (tx) => {
      await tx.pendingRoleGrant.deleteMany({ where: { userID } });
      await tx.roleAuditLog.create({ data: {
        actorUserID: "system:login", actorRoles: [], targetUserID: userID,
        action: "pending.claim", rolesBefore: before, rolesAfter: after,
        ok: true, batchId: p.batchId ?? null,
        reason: dropped.length ? `dropped: ${dropped.join(",")}` : null,
      }});
    });
    await stamp();
  } catch (err) {
    console.error(JSON.stringify({ evt: "pending_grants_failed", userID, err: String(err) }));
  }
}
```

`batchId` is carried into the `pending.claim` audit row **on purpose**: doc `03-admin-dashboard.md`'s bulk-undo selects reversible rows by `batchId`, and without it a claimed grant survives the undo of the import that created it — escalation outliving its own rollback.

`resident` is **never** a pending grant — it is not in `GRANTABLE_ROLES`, so it is unrepresentable in the payload (I-8e), and §2.6/I-8b cover it unconditionally anyway. `admin` is never auto-redeemed; `createPendingGrants` (§8) rejects it unless the caller is admin, and the redemption above will drop it if the granter has since lost admin.

### Step 2.6 — Grant points (I-8a), enumerated from the actual code

Every path that creates a `User` document must ensure the baseline **in the same request**. There are exactly three live creation paths in `src/` and two script paths. **Adding a new account-creation path without a baseline grant is a silent lockout of every account it creates**, so this is a merge-blocking grep gate:

```
grep -rnE 'user\.create|user\.createMany|user\.upsert|createUser|insert:\s*"User"' src/ scripts/
```

Every hit is either a grant point below or carries a comment naming why it is not. (The narrower `user\.create|createUser` form misses `createMany` and `$runCommandRaw({insert:"User"})`, both plausible in the remediation scripts — and by this document's own framing a miss is a lockout.)

**G-A — credentials registration, `src/app/api/register/route.ts:85`.** The only `db.user.create` in `src/`. After the existing create, in the same request:

```ts
await ensureBaseline(db, email);   // awaited; never throws
```

Placed **after** the create, deliberately **not** in a cross-collection transaction with it: the baseline is repairable and the `User` row is not, so a transaction failure would fail an otherwise-good registration to protect the cheaper half. If `ensureBaseline` returns false, registration still returns 201 and I-8b repairs at first login. Two adjacent fixes belong in the same edit: `:51`'s `!email.endsWith("@u.nus.edu")` becomes `isNusStudentEmail` (it rejects `E1234567@U.NUS.EDU` today — a user who cannot register cannot receive the baseline), and `:89`'s unanchored `.replace()` becomes `canonicalUserID` (I-1).

**G-B — Google first sign-in, `src/server/auth.ts:50` `PrismaAdapter(db)`. The hook goes in `events.createUser`.** Getting this wrong is the silent-lockout case:

| Candidate | Verdict |
|---|---|
| `callbacks.signIn` | **No.** It runs *before* the adapter writes the `User` row, so "the account exists" is not yet true — and its return value is the D-7 gate, so overloading it turns a baseline write failure into a sign-in denial. One job only. |
| `events.linkAccount` | **No, not as the grant point.** It fires when an `Account` is attached to an *existing* `User` — including a credentials user adding Google, who already holds a baseline. It misses nothing but means nothing. |
| `events.createUser` | **Yes.** Fires exactly once, immediately after `PrismaAdapter` inserts the `User` row, receives the created `user`, and is awaited by NextAuth v4. Exactly "an account was created" semantics. |

```ts
// src/server/auth.ts — new top-level key on authOptions, beside `callbacks`
events: {
  async createUser({ user }) {
    // MUST be individually try/caught. In next-auth v4 the OAuth flow awaits
    // events.createUser inside callback-handler, and a rejection propagates to
    // routes/callback.ts, which redirects to /api/auth/error?error=Callback —
    // i.e. the user's FIRST Google sign-in fails. (It self-recovers: on retry
    // the User row exists, createUser does not re-fire, and I-8b heals them.)
    // Do not write "a rejection does not deny the sign-in" here; it does.
    try {
      // PrismaAdapter writes ONLY email/name/image/emailVerified — User.userID
      // is NOT set on adapter-created rows (prisma/schema.prisma:352 is
      // String?). Reading user.userID here yields null and silently keys the
      // grant on "": the classic mis-keyed grant. The key comes from the
      // EMAIL (I-1), and ensureBaseline canonicalizes it itself.
      await ensureBaseline(db, user.email ?? "");
    } catch (e) {
      console.error(JSON.stringify({ evt: "baseline_grant_failed", err: String(e) }));
    }
  },
},
```

Ordering: the D-7 `signIn` callback must ship in the same deploy or earlier. In v4 `callbacks.signIn` runs *before* `callbackHandler` for OAuth, so a non-NUS Google account never reaches `createUser` and no `User` row is created at all — the ordering requirement stands, but there is no residual integrity nuisance to reason about.

**G-C — first session read of any pre-existing account, `callbacks.session`.** This is I-8b (§2.4). Listed here because in practice it is the grant point covering the largest population: everyone who existed before this ships, and everyone the backfill missed.

**G-D — `scripts/remediation/merge-accounts.mjs` and `dedupe-users.mjs`.** These merge/delete `User` rows and acquire two new obligations: the **surviving** account's canonical id must end up holding `resident` (`$addToSet`, upsert) — the survivor may be the row whose `UserRole` document was keyed on the loser's id — and the **losing** account's `UserRole` row must be pulled/deleted rather than left orphaned, so the doctor's "resident row keyed on a non-canonical id" line can reach zero.

**G-E — `scripts/remediation/seed-rbac.mjs`: delete it,** as `05-verification.md` already schedules. Under the stored baseline it gains a second reason to die: it writes `{ role }` with no `roles[]` and no baseline, so one run creates documents that self-heal must later repair. Delete, do not guard.

**Non-grant points, stated so nobody adds a redundant hook.** `src/server/api/routers/user.ts:94` `setMatric` upserts `UserMatric`, not `UserRole` — tempting as a second self-heal site since a user reaching the matric gate is definitionally new, but it is strictly dominated by G-C, which already ran earlier in the same request. `src/app/api/reset-password/*` creates no users. Deferred-grant redemption writes `UserRole` but is not a creation path (§2.5 covers it).

---

## 3. Role vocabulary and the stored `resident` baseline

### Step 3.1 — `src/server/api/services/roles.ts` (new)

Split deliberately from `access.ts`: this module is *vocabulary* (pure, safe to import anywhere), `access.ts` remains *policy* (server only, takes a `PrismaClient`).

```ts
export { canonicalUserID, isNusStudentEmail, normalizeEmail } from "~/lib/identity";
import { canonicalUserID } from "~/lib/identity";

/**
 * Single source of truth for role identifiers (RBAC v2).
 * Adding a role = add it here and to ASSIGNABLE_BY, and nothing else.
 */
export const ROLES = ["admin", "jcrc", "cca_head", "resident"] as const;
// NOTE: the v1 pseudo-role "user" is DELETED from the vocabulary (00-overview.md
// §2.2); `resident` is the floor. Do not re-add it — an unused enum member is a
// read-boundary hazard (07-cca-future.md §1.4).
export type Role = (typeof ROLES)[number];

export const ADMIN_ROLE = "admin" as const;
export const JCRC_ROLE = "jcrc" as const;
export const CCA_HEAD_ROLE = "cca_head" as const;
/**
 * Baseline capability of every verified NUS account. STORED and auto-assigned
 * (I-8), never GRANTABLE: it is written only by ensureBaseline, the register
 * route, the createUser event and the backfill — never through the role UI.
 */
export const BASELINE_ROLE = "resident" as const;

/**
 * Roles that survive every role write, because they cannot be expressed in a
 * removal payload (I-8c). SINGLE SOURCE — roleService imports it, and doc 03's
 * admin UI imports it so the preview's `After` column matches what the server
 * will actually do. The UI list is NOT the mechanism; §6 is.
 */
export const STICKY = [BASELINE_ROLE] as const;
/**
 * PRE-V2 LEGACY CONSTANT ONLY — the value the still-deployed `access.ts:19`
 * falls back to (`row?.role ?? DEFAULT_ROLE`). It is deliberately NOT a member
 * of `ROLES` and is `Role`-incompatible: "user" is not part of the v2
 * vocabulary. Never stored, never granted, never compared against `roles[]`.
 * Removed with the legacy scalar in `06-legacy-cutover.md` §5 step 4.
 */
export const DEFAULT_ROLE = "user" as const;

/**
 * Roles the admin dashboard, bulk import and deferred grants may write.
 *
 * `resident` is DELIBERATELY ABSENT (I-8e), and under the STORED baseline its
 * absence does more work than it used to. §6 writes $pull(removed) with
 * `removed ⊆ before ∩ GRANTABLE_ROLES`. Because `resident` is not in this
 * list, it is not FILTERED OUT of the removal set — it is INCAPABLE OF
 * APPEARING IN IT. roleSchema cannot express it, ASSIGNABLE_BY and
 * REVOCABLE_FROM_OTHERS_BY do not contain it, and no set, bulk, undo or
 * deferred payload can carry it in either direction. That is the mechanism,
 * not a convention and not a UI list.
 *
 * Corollary, stated where someone might try it: a manual DATABASE revocation
 * of `resident` is not a sanction — I-8b repairs it at the target's next page
 * load. A booking ban is a separate affirmative flag (§0.1), never the absence
 * of the baseline.
 */
export const GRANTABLE_ROLES = ["admin", "jcrc", "cca_head"] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

/**
 * Roles a FACILITY may require. Separate enum from GRANTABLE_ROLES because
 * D-1 pulled the two domains apart: `resident` is requirable but not grantable,
 * and `admin` is grantable but must NEVER be stored in requiredRoles (it is an
 * implicit bypass; storing it invites someone to delete it and lock admins out).
 */
export const FACILITY_ROLES = ["resident", "jcrc", "cca_head"] as const;
export type FacilityRole = (typeof FACILITY_ROLES)[number];

/**
 * Legacy-mirror precedence for the D-6 dual-write window. Must match
 * seed-roles-v2.mjs. `resident` is deliberately EXCLUDED: the only consumer of
 * the legacy scalar is a rollback to the pre-v2 access.ts, which is
 * default-OPEN and cannot interpret `resident`. Writing it there would be
 * meaningless at best and would displace a real value at worst.
 * Removed entirely in doc 06.
 */
export const PRECEDENCE = ["admin", "jcrc", "cca_head"] as const;
export function legacyMirror(roles: readonly string[]): string | null {
  return PRECEDENCE.find((r) => roles.includes(r)) ?? null;
}

/**
 * Privilege-escalation firewall as DATA, not if-statements.
 * Null prototype: a router that ever passes an unvalidated string must not be
 * able to reach Object.prototype via ASSIGNABLE_BY["constructor"].
 *
 * Constrains WHICH ROLES a caller may touch. It does NOT constrain WHICH
 * TARGET — that is the separate target guard G3. Both are required; neither
 * is sufficient.
 */
export const ASSIGNABLE_BY: Record<string, readonly GrantableRole[]> =
  Object.assign(Object.create(null) as Record<string, readonly GrantableRole[]>, {
    admin: ["admin", "jcrc", "cca_head"] as const,
    // D-3, OVERRIDING v1: a jcrc may NOT grant jcrc. Only admins grant or
    // revoke jcrc. Consequence to be aware of: a jcrc who steps down can be
    // restored only by an admin, not by a peer.
    jcrc: ["cca_head"] as const,
    cca_head: [] as const,
    resident: [] as const,
    user: [] as const,
  });

/**
 * Roles a caller may REVOKE from ANOTHER user. Under D-3 this is now identical
 * to ASSIGNABLE_BY; the two maps are kept separate because they answer
 * different questions and will diverge again if a role is ever made
 * grant-but-not-revoke.
 */
export const REVOCABLE_FROM_OTHERS_BY: Record<string, readonly GrantableRole[]> =
  Object.assign(Object.create(null) as Record<string, readonly GrantableRole[]>, {
    admin: ["admin", "jcrc", "cca_head"] as const,
    jcrc: ["cca_head"] as const,
    cca_head: [] as const,
    resident: [] as const,
    user: [] as const,
  });

export function isGrantableRole(v: string): v is GrantableRole {
  return (GRANTABLE_ROLES as readonly string[]).includes(v);
}

function union(map: Record<string, readonly GrantableRole[]>, callerRoles: readonly string[]) {
  const out = new Set<GrantableRole>();
  for (const r of callerRoles) for (const a of map[r] ?? []) out.add(a);
  return out;
}
export const assignableBy = (roles: readonly string[]) => union(ASSIGNABLE_BY, roles);
export const revocableFromOthersBy = (roles: readonly string[]) => union(REVOCABLE_FROM_OTHERS_BY, roles);

/**
 * POST-CANONICALIZATION SANITY CHECK on an id. NOT an authorization test and
 * NOT a provenance test — it is a pure SHAPE test and it carries no evidence
 * about where its argument came from.
 *
 * Renamed from `isResidentEligible` on purpose. Under the stored baseline this
 * predicate GATES A WRITE (I-8d), and the old name invited exactly the misuse
 * that breaks it: calling it on an admin-supplied `targetUserID` and concluding
 * that the principal is NUS-verified. It is sound ONLY over a string that
 * canonicalUserID() has just produced, which is why ensureBaseline takes an
 * EMAIL and canonicalizes internally rather than accepting an id (§2.5).
 * Note also that an `EXT:`-namespaced allowlist pin would pass this test — see
 * the break-glass note in §2.1.
 *
 * Deliberately NOT E_FORMAT.test(id): `g.s_samuel@u.nus.edu` is a real,
 * legitimate account whose canonical id is "G.S_SAMUEL". Gating the baseline
 * WRITE on E-format would withhold it permanently, not merely mis-derive once.
 */
export function isCanonicalResidentID(userID: string | null | undefined): boolean {
  return typeof userID === "string" && userID.length > 0 && !userID.includes("@");
}

/**
 * THE read boundary. Every role consumer goes through this. Replaces v1's
 * normalizeRoles entirely — grep gate before merge: zero call sites of
 * `normalizeRoles` outside this file.
 *
 * Takes ONLY the stored array. It does not take a userID and it derives
 * nothing: under I-8 the stored value IS the truth. Unknown strings are
 * dropped, so a stray script write can never become a live permission — and
 * `resident` is KEPT, because it is now a known, valid member of ROLES. The
 * v2 discard-then-re-derive step is gone; keeping it would have made a
 * read-boundary filter able to erase a real stored grant.
 */
export function normalizeStoredRoles(
  stored: readonly string[] | null | undefined,
): Role[] {
  const out = new Set<Role>();
  for (const r of stored ?? []) {
    if (isGrantableRole(r) || r === BASELINE_ROLE) out.add(r as Role);
  }
  return [...out];
}

/**
 * E-format NUSNET id. A VALIDATION rule for grant targets and pasted bulk
 * input ONLY — never an eligibility test (see isCanonicalResidentID) and
 * never a gate on the baseline write.
 */
export const E_FORMAT = /^E\d{7}$/;
export function isEFormatUserID(id: string): boolean {
  return E_FORMAT.test(id);
}
```

> `isCanonicalUserID` from v1 is renamed `isEFormatUserID` to stop it being read as an eligibility predicate. That misreading is a real lockout: gating the baseline on `/^E\d{7}$/` silently excludes every legitimate non-E-format `@u.nus.edu` localpart.
>
> Note the residual, honestly: guard **G7 (§6) still requires E-format of a role-mutation target**, so `G.S_SAMUEL` cannot be a `setUserRoles` or bulk-import target. That is a pre-existing decision about the *mutation* path and it is orthogonal to the baseline — `ensureBaseline` covers such users regardless, so it is not a booking lockout. Do not "fix" it by loosening G7 without also deciding what validates pasted bulk input.

---

## 4. Booking authorization: default-deny + kill switch

### Step 4.1 — `src/server/api/services/flags.ts` (new)

**Why a database row and not just the env var.** The brief asks for revert "in one env var without a redeploy". On Vercel, environment variables are snapshotted per deployment — editing one in the dashboard requires a redeploy to take effect. Shipping only an env var would be a false safety net on the day it matters. So: **the env var is the deploy-level default; a `SystemFlag` row overrides it live.**

`SystemFlag` is a new collection (model in doc `01-data-model.md`) — no `$jsonSchema` validator, no required non-list scalars beyond the `@unique` key.

```ts
import type { PrismaClient } from "@prisma/client";

export type EnforcementMode = "off" | "permissive" | "enforce";
const KEY = "rbac.booking.enforcement";
const TTL_MS = 15_000;
let cache: { at: number; mode: EnforcementMode } | null = null;

const MODES = ["off", "permissive", "enforce"] as const;

/**
 * Cache is per-lambda-instance, so 15s is the worst-case revert skew. Do NOT
 * raise it — time-to-revert is the entire value of this switch.
 */
export async function getEnforcementMode(db: PrismaClient): Promise<EnforcementMode> {
  const fallback = (process.env.RBAC_BOOKING_ENFORCEMENT ?? "off") as EnforcementMode;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.mode;
  try {
    const row = await db.systemFlag.findUnique({ where: { key: KEY } });
    const mode = (MODES as readonly string[]).includes(row?.value ?? "")
      ? (row!.value as EnforcementMode)
      : fallback;
    cache = { at: Date.now(), mode };
    return mode;
  } catch {
    // Fail to LEGACY semantics on an Atlas hiccup — see the note below on what
    // "off" means. An unreachable flag must degrade to today's behaviour, not
    // to no behaviour.
    return "off";
  }
}
```

### Step 4.2 — What the three modes mean

| Mode | Behaviour |
|---|---|
| `off` | **LEGACY semantics, NOT blanket-allow.** A facility with a non-empty `requiredRoles` is still enforced (with admin bypass); a facility with no row or an empty array is open to all. This is byte-identical to `access.ts:36-39` today. |
| `permissive` | Full D-1 evaluation runs; a would-be denial is written to `RoleAuditLog` as `booking.denied.shadow` and the booking **succeeds**. |
| `enforce` | Full D-1 evaluation; denials are real. |

`off` must not be blanket-allow. SCRC Room is gated **today**; a kill switch that returns `true` unconditionally would silently un-gate every currently-gated room for the whole soak window and for the entire duration of any revert. That is a security regression introduced by the safety mechanism.

`permissive` is the rollout mode, not a curiosity: run it against real traffic for at least 72 hours spanning a weekday and a weekend, then read the log. Zero `NOT_RESIDENT` denials means the backfill plus the grant points plus self-heal cover everyone. A cluster of them names the exact userIDs, before anyone is hurt — and under the stored baseline that is now a *real* signal rather than an impossible one, so it must be read, not assumed empty. Shadow-denial audit writes are best-effort — wrapped in `try/catch`, never allowed to fail a booking.

### Step 4.3 — Rewrite `src/server/api/services/access.ts`

Replace the file entirely.

```ts
import type { PrismaClient } from "@prisma/client";
import {
  ADMIN_ROLE, JCRC_ROLE, DEFAULT_ROLE, BASELINE_ROLE,
  normalizeStoredRoles, isCanonicalResidentID, type Role,
} from "./roles";
import { ensureBaseline } from "./baseline";
import { getEnforcementMode, type EnforcementMode } from "./flags";

export { ADMIN_ROLE, JCRC_ROLE, DEFAULT_ROLE };

/** D-1. A facility with no row, or an empty array, requires exactly this. */
export const DEFAULT_REQUIRED_ROLES = ["resident"] as const;

/**
 * Canonical role read. Tolerates rows still carrying only the legacy singular
 * `role` (the D-6 dual-write window; doc 06 removes the fallback).
 * normalizeStoredRoles drops unknown strings and KEEPS a stored `resident`.
 *
 * Under I-8 this returns EXACTLY what is stored — it derives nothing. A user
 * with no row gets []. That is not a lockout because the session callback has
 * already run ensureBaseline in this same request (§0.1 chokepoint property),
 * and because evaluateBooking retries the repair once before denying.
 * The `if (!userID) return []` guard is load-bearing: without it a ""-keyed
 * row would hand its roles to every non-canonicalizable principal.
 */
export async function getUserRoles(
  db: PrismaClient,
  userID: string | undefined | null,
): Promise<Role[]> {
  if (!userID) return [];
  const row = await db.userRole.findUnique({ where: { userID } });
  const stored = row?.roles?.length ? row.roles : row?.role ? [row.role] : [];
  return normalizeStoredRoles(stored);
}

export async function isAdmin(db: PrismaClient, userID: string | undefined | null) {
  return (await getUserRoles(db, userID)).includes(ADMIN_ROLE);
}

/** admin or jcrc — may reach the role-management surface at all. */
export function canManageRoles(roles: readonly string[]): boolean {
  return roles.includes(ADMIN_ROLE) || roles.includes(JCRC_ROLE);
}

/**
 * Facility requirement, OR-set. NOTE the absence of `if (!row) return []` and
 * of any early `return []` — those were the two open-by-default paths.
 */
export async function getFacilityRequiredRoles(
  db: PrismaClient,
  facilityID: number,
): Promise<string[]> {
  const row = await db.facilityAccess.findUnique({ where: { facilityID } });
  if (row?.requiredRoles?.length) return row.requiredRoles;
  if (row?.requiredRole) return [row.requiredRole];      // legacy window
  return [...DEFAULT_REQUIRED_ROLES];
}

/**
 * Pure predicate. NOTE the absence of `if (requiredRoles.length === 0) return
 * true` — that short-circuit WAS the lockout inversion.
 */
export function canBookWithRoles(
  userRoles: readonly string[],
  requiredRoles: readonly string[],
): boolean {
  if (userRoles.includes(ADMIN_ROLE)) return true;       // implicit bypass
  const req = requiredRoles.length ? requiredRoles : DEFAULT_REQUIRED_ROLES;
  return req.some((r) => userRoles.includes(r));
}

/** Legacy (pre-D-1) predicate, used ONLY by enforcement mode "off". */
function canBookLegacy(userRoles: readonly string[], requiredRoles: readonly string[]): boolean {
  if (requiredRoles.length === 0) return true;           // pre-D-1 open-to-all
  if (userRoles.includes(ADMIN_ROLE)) return true;
  return requiredRoles.some((r) => userRoles.includes(r));
}

export type BookDecision =
  | { ok: true }
  | { ok: false; reason: "NOT_ELIGIBLE" | "NOT_RESIDENT" | "ROLE_REQUIRED"; requiredRoles: string[] };

/**
 * Structured denial, so the UI can say WHY instead of a bare FORBIDDEN.
 *
 * `email` is OPTIONAL and is the caller's VERIFIED session email. Callers on a
 * real request path (createBooking, updateBooking) pass
 * `ctx.session.user.email`; admin.explainAccess deliberately does not, because
 * it evaluates AS a third party and must not mint that party a baseline as a
 * side effect of being inspected.
 */
export async function evaluateBooking(
  db: PrismaClient,
  userID: string | null | undefined,
  facilityID: number,
  email?: string | null,
): Promise<BookDecision> {
  const [required, roles] = await Promise.all([
    getFacilityRequiredRoles(db, facilityID),
    getUserRoles(db, userID),
  ]);
  if (canBookWithRoles(roles, required)) return { ok: true };
  if (!userID) return { ok: false, reason: "NOT_ELIGIBLE", requiredRoles: required };

  if (!roles.includes(BASELINE_ROLE)) {
    // REPAIR-ON-DENY (I-8b, second site). The session callback already tried
    // once this request; if its write failed, retry here — on the exact
    // request that needs the baseline — before denying. Bounded: ensureBaseline
    // is circuit-broken per lambda, so a UserRole-scoped outage does not turn
    // every booking attempt into a retry storm.
    //
    // The honest limit, stated so nobody mistakes this for closure: if the
    // repair fails again, the deny stands. That is lockout mode L-6, and it is
    // MITIGATED + DETECTED (baseline_repair_failed → admin.systemHealth → the
    // daily doctor query), not closed. Note that a booking is itself a write:
    // if Atlas is refusing writes, createBooking fails regardless of roles, so
    // a general write outage is not a DIFFERENTIAL lockout. What is genuinely
    // worse than the derived design is a PARTIAL failure — writes succeeding
    // elsewhere but failing on UserRole.
    if (email && isCanonicalResidentID(userID) && (await ensureBaseline(db, email))) {
      const repaired = await getUserRoles(db, userID);
      if (canBookWithRoles(repaired, required)) return { ok: true };
      if (repaired.includes(BASELINE_ROLE)) {
        return { ok: false, reason: "ROLE_REQUIRED", requiredRoles: required };
      }
    }
    return { ok: false, reason: "NOT_RESIDENT", requiredRoles: required };
  }
  return { ok: false, reason: "ROLE_REQUIRED", requiredRoles: required };
}

/** Kill-switch-aware. THE enforcement entry point for createBooking. */
export async function evaluateBookingWithMode(
  db: PrismaClient,
  userID: string | null | undefined,
  facilityID: number,
  email?: string | null,          // verified session email, for repair-on-deny
): Promise<BookDecision> {
  const mode = await getEnforcementMode(db);

  if (mode === "off") {
    const row = await db.facilityAccess.findUnique({ where: { facilityID } });
    const legacyRequired = row?.requiredRoles?.length
      ? row.requiredRoles
      : row?.requiredRole ? [row.requiredRole] : [];
    const roles = legacyRequired.length ? await getUserRoles(db, userID) : [];
    return canBookLegacy(roles, legacyRequired)
      ? { ok: true }
      : { ok: false, reason: "ROLE_REQUIRED", requiredRoles: legacyRequired };
  }

  const d = await evaluateBooking(db, userID, facilityID, email);
  if (d.ok) return d;

  if (mode === "permissive") {
    try {
      await db.roleAuditLog.create({ data: {
        actorUserID: userID ?? "(anon)", actorRoles: [],
        targetUserID: userID ?? null, targetFacilityID: facilityID,
        action: "booking.denied.shadow", rolesBefore: [], rolesAfter: [],
        ok: false, denyReason: d.reason,
      }});
    } catch { /* best effort — a shadow audit must never fail a booking */ }
    return { ok: true };
  }
  return d;
}

/** Thin boolean wrapper for callers that do not need the reason code. */
export async function canBookFacility(
  db: PrismaClient,
  userID: string | undefined | null,
  facilityID: number,
  email?: string | null,
): Promise<boolean> {
  return (await evaluateBookingWithMode(db, userID, facilityID, email)).ok;
}

/**
 * Bulk map for the picker. Built from Facilities, NOT from FacilityAccess —
 * v1 iterated FacilityAccess and therefore could not represent a facility with
 * no row, which under D-1 is the majority case.
 */
export async function getBookableFacilityMap(
  db: PrismaClient,
  userID: string | undefined | null,
): Promise<Map<number, { canBook: boolean; requiredRoles: string[] }>> {
  const [facilities, rows, roles, mode] = await Promise.all([
    db.facilities.findMany({ select: { facilityID: true } }),
    db.facilityAccess.findMany(),
    getUserRoles(db, userID),
    getEnforcementMode(db),
  ]);
  const req = new Map(rows.map((r) => [
    r.facilityID,
    r.requiredRoles?.length ? r.requiredRoles : r.requiredRole ? [r.requiredRole] : [],
  ]));
  const out = new Map<number, { canBook: boolean; requiredRoles: string[] }>();
  for (const f of facilities) {
    const raw = req.get(f.facilityID) ?? [];
    const required = raw.length ? raw : [...DEFAULT_REQUIRED_ROLES];
    out.set(f.facilityID, {
      canBook: mode === "off" ? canBookLegacy(roles, raw) : canBookWithRoles(roles, required),
      requiredRoles: required,
    });
  }
  return out;
}

// getUserRole (singular) is DELETED. Invariant I-6: roles[0] is $addToSet
// insertion order, so an admin+jcrc user would silently lose admin at the two
// facilitiesBooking call sites. Use isAdmin() or getUserRoles().
```

### Step 4.4 — Convert `src/server/api/routers/facilitiesBooking.ts` (SAME COMMIT as 4.3)

Line ~10, the import:

```diff
-import { canBookFacility, getUserRole, ADMIN_ROLE } from "../services/access";
+import {
+  evaluateBookingWithMode, isAdmin, getBookableFacilityMap,
+  type BookDecision,
+} from "../services/access";
```

Lines ~129–131 (`getBookings`, the `seeAll` gate):

```diff
-      const role = await getUserRole(ctx.db, callerUserID);
-      const canSeeAll = Boolean(seeAll) && role === ADMIN_ROLE;
+      const canSeeAll = Boolean(seeAll) && (await isAdmin(ctx.db, callerUserID));
```

Lines ~383–384 (`deleteBooking`):

```diff
-      const role = await getUserRole(ctx.db, ctx.session.user.userID);
-      if (existing.userID !== ctx.session.user.userID && role !== ADMIN_ROLE) {
+      if (
+        existing.userID !== ctx.session.user.userID &&
+        !(await isAdmin(ctx.db, ctx.session.user.userID))
+      ) {
```

Line ~319 (`createBooking`) — **this line does change**, contrary to v1. The reason code is computed anyway; discarding it leaves the user with a bare "not allowed" and turns every lockout into a support ticket.

```diff
-      if (!(await canBookFacility(ctx.db, userID, input.facilityID))) {
-        throw new TRPCError({
-          code: "FORBIDDEN",
-          message: "You are not allowed to book this facility.",
-        });
-      }
+      // The 4th argument is the VERIFIED session email, and it is what makes
+      // repair-on-deny (§4.3) reachable. Omitting it silently downgrades a
+      // recoverable NOT_RESIDENT into a hard denial.
+      const decision = await evaluateBookingWithMode(
+        ctx.db, userID, input.facilityID, ctx.session.user.email,
+      );
+      if (!decision.ok) {
+        throw new TRPCError({ code: "FORBIDDEN", message: denialMessage(decision) });
+      }
```

with, at module scope:

```ts
/** Distinct from matricProcedure's MATRIC_REQUIRED so triage cannot confuse them. */
function denialMessage(d: Extract<BookDecision, { ok: false }>): string {
  switch (d.reason) {
    case "NOT_ELIGIBLE":
      return "Your account is not a verified NUS student account. Please sign in with your @u.nus.edu email.";
    case "NOT_RESIDENT":
      return "Your account is not recognised as a hall resident. Please contact the JCRC.";
    case "ROLE_REQUIRED":
      return `This room is restricted to: ${d.requiredRoles.join(" or ")}.`;
  }
}
```

`updateBooking` (~line 404) — two fixes, because a user whose role was revoked can currently extend a booking on a gated facility indefinitely:

```diff
-  updateBooking: protectedProcedure
+  updateBooking: matricProcedure
```
```diff
       if (existingBooking.userID !== ctx.session?.user?.userID) {
-        throw new Error("Unauthorized: Can only edit your own bookings");
+        throw new TRPCError({ code: "FORBIDDEN", message: "You can only edit your own bookings." });
       }
+
+      // Re-check facility access when times change. facilityID is not editable,
+      // so this is not a cross-facility escalation — it closes the "revoked
+      // user keeps rescheduling" hole.
+      if (startTime !== undefined || endTime !== undefined) {
+        const d = await evaluateBookingWithMode(
+          ctx.db, ctx.session.user.userID, existingBooking.facilityID,
+          ctx.session.user.email,
+        );
+        if (!d.ok) throw new TRPCError({ code: "FORBIDDEN", message: denialMessage(d) });
+      }
```

New procedure, beside `getAllFacilities`:

```ts
  /**
   * Server-driven facility permissions for the booking picker. ADVISORY ONLY —
   * createBooking remains the enforcement point (invariant I-7).
   *
   * Under D-1 most rooms are gated, so "renders in the picker, fails at submit"
   * becomes the dominant path. Wiring this into BookingModal is NO LONGER
   * optional; doc 03 owns that.
   */
  getFacilitiesForBooking: protectedProcedure.query(async ({ ctx }) => {
    const [facilities, permMap] = await Promise.all([
      ctx.db.facilities.findMany({ orderBy: { facilityID: "asc" } }),
      getBookableFacilityMap(ctx.db, ctx.session.user.userID),
    ]);
    return facilities.map((f) => ({
      ...f,
      canBook: permMap.get(f.facilityID)?.canBook ?? false,
      requiredRoles: permMap.get(f.facilityID)?.requiredRoles ?? ["resident"],
    }));
  }),
```

> `getAllFacilities` is **retained unchanged**. It is a `publicProcedure` with three consumers — `src/app/_components/Calendar.tsx:24`, `Calender_v2.tsx:96`, `PastBookings.tsx:66` — of which the latter two are display-only. Narrowing or removing it breaks them. Grep gate before merge: **no `getAllFacilities` call site is used to decide whether a booking control is enabled.**

---

## 5. tRPC guards: `src/server/api/trpc.ts`

Amend `protectedProcedure` first — this is what makes `session.user.eligible` an authoritative denial rather than a decoration. Without it, an ineligible legacy session keeps every non-role-gated capability (posts, profile mutations, reads) for up to 30 days.

```diff
 export const protectedProcedure = t.procedure
   .use(timingMiddleware)
   .use(({ ctx, next }) => {
     if (!ctx.session?.user) {
       throw new TRPCError({ code: "UNAUTHORIZED" });
     }
+    // D-7 backstop for pre-cutover JWTs. `eligible` is set by the session
+    // callback from canonicalUserID(token.email) !== "" — a live DB-free
+    // derivation from the token's own email, so trusting it here is not an
+    // I-5 violation (it is not a role, and it is not cached in the token).
+    if (!ctx.session.user.eligible) {
+      throw new TRPCError({ code: "FORBIDDEN", message: "NUS_ACCOUNT_REQUIRED" });
+    }
     return next({
       ctx: { session: { ...ctx.session, user: ctx.session.user } },
     });
   });
```

Doc `03-admin-dashboard.md` owns the client half: `MatricGate` must branch on `eligible === false` **before** its `hasMatric` check and route to an explanatory page with a working sign-out. Otherwise an ineligible user has `userID === ""` and `hasMatric === false`, so the gate redirects them to `/onboarding/matric` forever, where `setMatric` throws on the empty key. That is a worse outcome than a clean logout.

Append after `matricProcedure`:

```ts
import { ADMIN_ROLE, JCRC_ROLE } from "~/server/api/services/roles";

/**
 * Reusable role middleware. Authenticated AND holds at least one of `allowed`.
 * `admin` implicitly satisfies every role check.
 *
 * Reads ctx.session.user.roles, which the session callback populates with a
 * LIVE database read on every request — so there is no stale privilege window.
 * This is a COARSE gate: what a caller may do to WHICH TARGET is enforced
 * per-mutation by assertCanMutateRoles (§6).
 *
 * A middleware, not a pre-built procedure, so it composes:
 * `matricProcedure.use(requireRoles("jcrc"))` works.
 */
export const requireRoles = (...allowed: string[]) =>
  t.middleware(({ ctx, next }) => {
    if (!ctx.session?.user) throw new TRPCError({ code: "UNAUTHORIZED" });
    const roles = ctx.session.user.roles ?? [];
    if (!roles.includes(ADMIN_ROLE) && !allowed.some((r) => roles.includes(r))) {
      throw new TRPCError({ code: "FORBIDDEN", message: "INSUFFICIENT_ROLE" });
    }
    return next({ ctx });
  });

export const roleProcedure = (...allowed: string[]) =>
  protectedProcedure.use(requireRoles(...allowed));

/** Strictly `admin`. No other role satisfies it. */
export const adminProcedure = protectedProcedure.use(
  t.middleware(({ ctx, next }) => {
    if (!(ctx.session?.user?.roles ?? []).includes(ADMIN_ROLE)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "ADMIN_REQUIRED" });
    }
    return next({ ctx });
  }),
);

/** May reach role management at all: admin or jcrc. The D-2 dashboard gate. */
export const roleManagerProcedure = roleProcedure(JCRC_ROLE);

/** Composable matric gate, so role + matric can be layered. */
export const requireMatric = t.middleware(({ ctx, next }) => {
  if (!ctx.session?.user?.hasMatric) {
    throw new TRPCError({ code: "FORBIDDEN", message: "MATRIC_REQUIRED" });
  }
  return next({ ctx });
});
```

Role procedures build on `protectedProcedure`, **not** `matricProcedure` — an admin fixing someone's account must not be blocked by their own onboarding state.

---

## 6. The escalation guards: `src/server/api/services/roleService.ts` (new)

One choke point. Every role mutation calls it first. It **re-reads both actor and target roles from the database** rather than trusting the session (invariant I-5).

```ts
import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { getUserRoles } from "./access";
import {
  ADMIN_ROLE, JCRC_ROLE, assignableBy, revocableFromOthersBy,
  isGrantableRole, isEFormatUserID, legacyMirror, type GrantableRole,
} from "./roles";

export type AuditEntry = {
  actorUserID: string;
  actorRoles?: string[];
  targetUserID?: string;
  targetFacilityID?: number;
  action: string;
  rolesBefore?: string[];
  rolesAfter?: string[];
  reason?: string;
  ok?: boolean;
  denyReason?: string;
  batchId?: string;
};

/** Thrown by the guards when opts.dryRun is set. Not audited, caught by §8. */
export class DryRunDenied extends Error {
  constructor(public readonly denyReason: string) { super(denyReason); }
}

/**
 * Audit writer.
 *
 * CRITICAL: takes a PrismaClient, never a transaction client. A denial audit
 * written inside the transaction it is denying gets rolled back by the throw,
 * leaving no trace of exactly the event that most needs one. Every guard here
 * audits on `db`, outside any tx.
 *
 * Never lets an audit failure roll back an authorization decision — but a
 * failure on a DENIED row is the highest-signal security event this system
 * produces, so it is logged structurally, not swallowed.
 */
export async function writeAudit(db: PrismaClient, e: AuditEntry): Promise<void> {
  try {
    await db.roleAuditLog.create({ data: {
      actorUserID: e.actorUserID,
      actorRoles: e.actorRoles ?? [],
      targetUserID: e.targetUserID ?? null,
      targetFacilityID: e.targetFacilityID ?? null,
      action: e.action,
      rolesBefore: e.rolesBefore ?? [],
      rolesAfter: e.rolesAfter ?? [],
      reason: e.reason ?? null,
      ok: e.ok ?? true,
      denyReason: e.denyReason ?? null,
      batchId: e.batchId ?? null,
    }});
  } catch (err) {
    console.error(JSON.stringify({
      evt: "audit_write_failed", action: e.action, ok: e.ok ?? true,
      actorUserID: e.actorUserID, targetUserID: e.targetUserID,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

const forbid = (msg: string): never => {
  throw new TRPCError({ code: "FORBIDDEN", message: msg });
};

/**
 * THE privilege-escalation firewall. Computes the resulting role set for a
 * `set`-style request and validates it, or throws and audits the denial.
 *
 *  G1 CALLER      caller must hold admin or jcrc. (Also enforced by the
 *                 procedure middleware — belt and braces.)
 *  G2 VOCABULARY  every requested role must be a known GRANTABLE role. Zod
 *                 z.enum rejects most of these first; this survives a router
 *                 that forgets. Note `resident` fails G2 by design (I-8e): it
 *                 is not grantable, so no mutation can add OR remove it —
 *                 and, per the `removed` computation below, it cannot even
 *                 enter the removal payload.
 *  G3 TARGET      a non-admin may not touch ANY role of a user who holds
 *                 admin. Without this a jcrc calls set(admin_user, ["cca_head"])
 *                 — every role in the payload is inside jcrc's assignable set,
 *                 so an additions-only check passes, and the sole admin is
 *                 stripped. This is escalation-by-demotion and it is the single
 *                 most important line in this file.
 *  G4 DELTA       BOTH added and removed roles must be permitted. Checking
 *                 only additions is the same hole as G3 from another angle.
 *  G5 REVOKE      revoking from ANOTHER user uses the narrower
 *                 REVOCABLE_FROM_OTHERS_BY map. Self-revocation (stepping
 *                 down) of a non-admin role is always allowed. Under D-3, a
 *                 jcrc who steps down can only be restored by an ADMIN.
 *  G6 SELF-GRANT  a non-admin may not grant themselves a role they lack.
 *                 Scoped to non-admins: an admin already outranks every role,
 *                 and blocking them would leave the bootstrap admin unable to
 *                 give themselves jcrc with no in-app path to fix it. Under
 *                 D-3 this is now partly redundant for `jcrc` (already blocked
 *                 by the narrowed ASSIGNABLE_BY) — kept as defence in depth.
 *  G7 KEY         the target must be an E-format userID. Without this the
 *                 dashboard writes rows keyed on an A-format matric that no
 *                 session ever matches: the grant appears to succeed and does
 *                 nothing (invariant I-1).
 *
 * The LAST-ADMIN guard is NOT here: it must be transactional, and lives in
 * applyRoleChange.
 */
export async function assertCanMutateRoles(opts: {
  db: PrismaClient;
  actorUserID: string;
  targetUserID: string;
  requestedRoles: string[];
  /** Preview only (§8): evaluate the guards identically, but do not audit. */
  dryRun?: boolean;
}): Promise<{
  actorRoles: string[];
  before: GrantableRole[];
  after: GrantableRole[];
  /** The authorised delta. applyRoleChange writes THESE, never `after`. */
  added: GrantableRole[];
  removed: GrantableRole[];
}> {
  const { db, actorUserID, targetUserID, requestedRoles, dryRun } = opts;

  const [actorAll, targetAll] = await Promise.all([
    getUserRoles(db, actorUserID),
    getUserRoles(db, targetUserID),
  ]);
  // Restrict both sides to GRANTABLE roles. Under the STORED baseline this is
  // no longer merely tidiness — IT IS THE STICKY MECHANISM (I-8c). `removed`
  // below is computed as `before.filter(...)`, so confining `before` to
  // GRANTABLE_ROLES (which excludes `resident`) means the baseline is not
  // filtered out of the removal set: it is INCAPABLE OF ENTERING IT. Widen
  // this line and every role edit silently strips every user's ability to
  // book. It also still prevents the phantom-removal it prevented before.
  const actorRoles = actorAll.filter(isGrantableRole);
  const before = targetAll.filter(isGrantableRole);

  const actorIsAdmin = actorRoles.includes(ADMIN_ROLE);
  const isSelf = actorUserID === targetUserID;

  const deny = async (reason: string): Promise<never> => {
    if (dryRun) throw new DryRunDenied(reason);
    // Audited BEFORE throwing, on `db` and outside any transaction: there is
    // no state change to lose, and a probing attempt is exactly what must
    // leave a trail.
    await writeAudit(db, {
      actorUserID, actorRoles, targetUserID, action: "denied",
      rolesBefore: before, rolesAfter: requestedRoles,
      ok: false, denyReason: reason,
    });
    return forbid(reason);
  };

  if (!isEFormatUserID(targetUserID)) await deny("NOT_A_CANONICAL_USERID");        // G7
  if (!actorIsAdmin && !actorRoles.includes(JCRC_ROLE)) await deny("NOT_A_ROLE_MANAGER"); // G1
  for (const r of requestedRoles) if (!isGrantableRole(r)) await deny("UNKNOWN_ROLE");    // G2
  if (!actorIsAdmin && before.includes(ADMIN_ROLE)) await deny("CANNOT_MODIFY_AN_ADMIN"); // G3

  const requested = [...new Set(requestedRoles)] as GrantableRole[];
  const added = requested.filter((r) => !before.includes(r));
  const removed = before.filter((r) => !requested.includes(r));

  const canAssign = assignableBy(actorRoles);
  const canRevokeOthers = revocableFromOthersBy(actorRoles);

  for (const r of added) {                                                          // G4
    if (!canAssign.has(r)) await deny(`CANNOT_GRANT_${r.toUpperCase()}`);
    if (isSelf && !actorIsAdmin && !actorRoles.includes(r)) await deny("CANNOT_SELF_ASSIGN"); // G6
  }
  for (const r of removed) {                                                        // G4 + G5
    if (isSelf) {
      if (r === ADMIN_ROLE && !actorIsAdmin) await deny("CANNOT_REVOKE_ADMIN");
      continue;
    }
    if (!canRevokeOthers.has(r)) await deny(`CANNOT_REVOKE_${r.toUpperCase()}_FROM_OTHERS`);
  }

  return { actorRoles, before, after: requested, added, removed };
}

/**
 * Applies a validated role change with the LAST-ADMIN guard held INSIDE a
 * transaction. Read-then-write outside a transaction is not enough: with two
 * admins, two concurrent self-revocations both observe count === 2, both pass,
 * and the system reaches zero admins — unrecoverable, because there is
 * deliberately no in-app path to mint the first admin.
 *
 * THE STICKY CHOKEPOINT (I-8c). This is the ONE write on the role-mutation
 * path. Every surface routes through it: setUserRoles, every bulk-import row
 * (add AND replace mode — §8: "guards apply per row, never per batch"), and
 * every bulk-undo row (doc 03: "undo is a normal guarded role change, not a
 * privileged rollback"). The fourth surface, deferred-grant redemption, does
 * NOT route through here and is made additive-only in §2.5.
 */
export async function applyRoleChange(opts: {
  db: PrismaClient;
  actorUserID: string;
  actorRoles: string[];
  targetUserID: string;
  before: GrantableRole[];
  after: GrantableRole[];
  added: GrantableRole[];
  removed: GrantableRole[];
  reason?: string;
  batchId?: string;
}): Promise<GrantableRole[]> {
  const { db, actorUserID, actorRoles, targetUserID, before, after, added, removed, reason, batchId } = opts;
  const losingAdmin = before.includes(ADMIN_ROLE) && !after.includes(ADMIN_ROLE);

  // I-8c, asserted rather than assumed. `removed` comes from
  // assertCanMutateRoles, where it is `before.filter(...)` and `before` is
  // already grantable-only — so this can only fire if someone widens that
  // line. Cheap, and it fails loudly instead of stripping 515 baselines.
  if (removed.some((r) => !isGrantableRole(r))) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "NON_GRANTABLE_IN_REMOVAL" });
  }

  if (losingAdmin && actorUserID === targetUserID) {
    await writeAudit(db, {
      actorUserID, actorRoles, targetUserID, action: "denied",
      rolesBefore: before, rolesAfter: after, ok: false,
      denyReason: "CANNOT_SELF_REVOKE_ADMIN",
    });
    forbid("CANNOT_SELF_REVOKE_ADMIN");
  }

  await db.$transaction(async (tx) => {
    if (losingAdmin) {
      const remaining = await tx.userRole.count({
        where: {
          userID: { not: targetUserID },
          // Legacy-tolerant so an admin still on the singular shape is not
          // invisible to the count. Narrowing this to roles-only before doc
          // 06's gate proves no legacy-only row remains would permit removing
          // the real last admin.
          OR: [{ roles: { has: ADMIN_ROLE } }, { role: ADMIN_ROLE }],
        },
      });
      if (remaining < 1) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "CANNOT_REMOVE_LAST_ADMIN" });
      }
    }

    // ---- THE STICKY WRITE (I-8c, I-13) --------------------------------
    // Read the CURRENT full stored set inside the transaction, so the write
    // below is a compare-and-set against a pre-image observed under the same
    // session as the last-admin count.
    const row = await tx.userRole.findUnique({ where: { userID: targetUserID } });
    const current = row?.roles?.length ? row.roles : row?.role ? [row.role] : [];

    // OPTIMISTIC CONCURRENCY. Switching from a blind set-payload to a delta
    // changes the concurrency semantics adversarially and must be handled, not
    // assumed away: `added`/`removed` were computed from a `before` read in
    // assertCanMutateRoles, in an EARLIER statement. With two concurrent edits
    // and no check, actor A setting [admin] and actor B setting [jcrc]
    // interleave to a state neither requested — and worse, a REVOKE can be
    // silently undone by a concurrent grant, i.e. privilege retention after an
    // apparently successful revocation, with an audit row asserting a
    // rolesAfter that never existed. So: if the target's grantable set has
    // moved since the guards read it, refuse. CONFLICT_ROLES_CHANGED is a code
    // the bulk client already handles (doc 03).
    const currentGrantable = current.filter(isGrantableRole);
    const moved =
      currentGrantable.length !== before.length ||
      currentGrantable.some((r) => !before.includes(r));
    if (moved) {
      throw new TRPCError({ code: "CONFLICT", message: "CONFLICT_ROLES_CHANGED" });
    }

    // STICKY BY CONSTRUCTION. The written set is (everything stored that is
    // NOT grantable) ∪ (the authorised final grantable set). `resident` is not
    // grantable, so it lands in the first term and is PRESERVED — it is not
    // filtered out of a removal payload, it is incapable of entering one.
    //
    // Note what this deliberately does NOT do: it does not ADD `resident` to a
    // target that lacks it. `targetUserID` is admin/jcrc-supplied input whose
    // NUS provenance was never established (G7 checks E-format shape, not
    // provenance), and isCanonicalResidentID is a shape test carrying no
    // evidence (§3.1). Minting a baseline here would grant it to principals
    // that may not exist and were never email-verified. Granting is
    // ensureBaseline's job and only ensureBaseline's job (I-8a/I-8d).
    const keptNonGrantable = current.filter((r) => !isGrantableRole(r));
    const written = [...new Set([...keptNonGrantable, ...after])];

    await tx.userRole.upsert({
      where: { userID: targetUserID },
      create: {
        userID: targetUserID, roles: written, role: legacyMirror(after),
        updatedAt: new Date(), updatedBy: actorUserID,
      },
      update: {
        roles: written, role: legacyMirror(after),
        updatedAt: new Date(), updatedBy: actorUserID,
      },
    });
    // WHY A TYPED upsert AND NOT $runCommandRaw($pull/$addToSet):
    //  1. Prisma's MongoDB connector does NOT run raw commands inside the
    //     interactive transaction's session — a raw write executes OUTSIDE the
    //     transaction and commits independently of rollback. That would
    //     silently un-atomicise the last-admin guard above and re-open exactly
    //     the zero-admins race this transaction exists to prevent.
    //  2. A raw `updates: [$pull, $addToSet]` array is TWO document writes, not
    //     one: entry 1 succeeding and entry 2 failing leaves the target
    //     stripped of the revoked roles with none of the additions applied.
    //  3. $set and $setOnInsert may never name the same path — MongoDB rejects
    //     it with ConflictingUpdateOperators (I-9). No $setOnInsert appears
    //     here: legacyMirror() already writes `role` on BOTH branches, and it
    //     must return "" (not null/undefined) for an empty grantable set so the
    //     I-9 sentinel holds on insert. Assert that in a unit test.
    // This IS a set-payload, which I-13 forbids in its blind form — the
    // compare-and-set above is what makes it legal, and it is strictly stronger
    // than a blind delta. Do not remove the pre-image check "for speed".
    // -------------------------------------------------------------------
  });

  await writeAudit(db, {
    actorUserID, actorRoles, targetUserID, action: "set",
    rolesBefore: before, rolesAfter: after, reason, batchId, ok: true,
  });
  return after;
}
```

The legacy `role` mirror is written on **both** upsert branches, always via `legacyMirror` (highest privilege), never `after[0]`, and never over `written` — `resident` must not reach the legacy scalar, whose only consumer is a rollback to the pre-v2 `access.ts` that is default-open and cannot interpret it (`06-legacy-cutover.md` §0.1). Doc `06-legacy-cutover.md` removes the field; **in that same commit, remove `$setOnInsert: { role: "" }` from `ensureBaseline`**, or a permanent hot-path writer keeps resurrecting a dropped field after cutover and defeats doc 06's containment gate.

> **Sticky IS needed, and this is where it lives.** The v2 plan claimed the `resident` *derivation* made a sticky-merge rule unnecessary. Under the stored baseline that claim is false and the old advice — writing `after` verbatim — would strip `resident` from the target on **every single role edit**, across `setUserRoles`, every bulk-import row and every undo row. Stickiness is now enforced here, at the one write, by construction: `removed ⊆ before ∩ GRANTABLE_ROLES` and the written set preserves every stored non-grantable role. The `STICKY` list in `03-admin-dashboard.md` §10.4 is **not** the mechanism — it is a copy-consistency aid so the preview's `After` column matches what this function will do. Its comment must say so.
>
> A "last resident" guard analogous to the last-admin guard is still **not** needed and must not be added: there is no payload that can remove the last resident.

**Merge-blocking gate.** No Prisma `data:` object anywhere in `src/server/api/services/` or `src/server/api/routers/` may contain a `roles` key other than the single guarded upsert above and the two `$addToSet` raw writes in `baseline.ts`. Enforce it with an AST check (ts-morph) in the verification script, **not** a line-based grep: `grep -rn "roles:" … | grep -v addToSet` false-positives on a multi-line `$addToSet: {\n  roles: { $each: … }`, and per I-16's corollary a gate that cannot reach zero gets muted, which deletes the detector.

---

## 7. The admin router and the D-2 capability set

### Step 7.1 — `src/server/api/services/capabilities.ts` (new)

D-2 requires **one** dashboard whose behaviour is a capability set computed server-side, not an `if (isAdmin) … else …` fork. v1 forked in seven independent places (`assignableRoles` ternary, `getStats` branch, `ADMIN_TABS` filter, sibling layout guards, nav label, dialog disabled-states, bulk role options). None was a security hole — the server guards are independent — but seven copies of a policy is how the eighth one gets it wrong.

```ts
import { ADMIN_ROLE, JCRC_ROLE, GRANTABLE_ROLES, assignableBy,
         revocableFromOthersBy, type GrantableRole } from "./roles";

/**
 * The capability set. Computed ONCE, server-side, from the caller's live roles.
 * The dashboard renders off this object and branches on NOTHING else.
 *
 * Adding a capability = one field here + one server guard. If you find
 * yourself writing `roles.includes("admin")` in a component, it belongs here.
 */
export type Capabilities = {
  reachDashboard: boolean;
  listUsers: boolean;
  /** Roles this caller may grant. D-3: jcrc gets ["cca_head"] only. */
  assignableRoles: GrantableRole[];
  revocableRoles: GrantableRole[];
  /** May act on a user who holds `admin` at all. D-2: admin only. */
  modifyAdmins: boolean;
  /** May see WHO holds admin (counts and identities). D-2: admin only. */
  seeAdminIdentities: boolean;
  bulkAssign: boolean;
  createPendingGrants: boolean;
  undoBulkImport: boolean;
  readAuditLog: boolean;
  manageFacilityAccess: boolean;
  /** Aggregate health counts. Per-user identifier lists are admin-only. */
  viewSystemHealth: boolean;
  viewSystemHealthDetail: boolean;
  manageEnforcementFlag: boolean;
};

export function computeCapabilities(roles: readonly string[]): Capabilities {
  const isAdmin = roles.includes(ADMIN_ROLE);
  const isManager = isAdmin || roles.includes(JCRC_ROLE);
  return {
    reachDashboard: isManager,
    listUsers: isManager,
    assignableRoles: [...assignableBy(roles)],
    revocableRoles: [...revocableFromOthersBy(roles)],
    modifyAdmins: isAdmin,
    seeAdminIdentities: isAdmin,
    bulkAssign: isManager,
    createPendingGrants: isManager,
    undoBulkImport: isManager,
    readAuditLog: isAdmin,
    manageFacilityAccess: isAdmin,
    viewSystemHealth: isManager,
    viewSystemHealthDetail: isAdmin,
    manageEnforcementFlag: isAdmin,
  };
}

/** Server-side assertion. Use in EVERY procedure whose gate is a capability. */
export function requireCapability<K extends keyof Capabilities>(
  caps: Capabilities, key: K,
): void {
  const v = caps[key];
  if (v === false || (Array.isArray(v) && v.length === 0)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `CAPABILITY_REQUIRED:${String(key)}` });
  }
}
```

`GRANTABLE_ROLES` is imported for the type only; `assignableRoles` is derived from `ASSIGNABLE_BY`, so D-3 is expressed once, in `roles.ts`, and propagates everywhere.

### Step 7.2 — Register the router

`src/server/api/root.ts`:

```diff
+import { adminRouter } from "~/server/api/routers/admin";

 export const appRouter = createTRPCRouter({
   post: postRouter,
   bookings: facilityBookingRouter,
   user: userRouter,
+  admin: adminRouter,
 });
```

### Step 7.3 — Shared schemas, `src/server/api/routers/admin.ts` (new)

```ts
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure, adminProcedure, roleManagerProcedure } from "../trpc";
import { getUserRoles, canManageRoles } from "../services/access";
import { assertCanMutateRoles, applyRoleChange, writeAudit, DryRunDenied } from "../services/roleService";
import { computeCapabilities, requireCapability } from "../services/capabilities";
import { GRANTABLE_ROLES, FACILITY_ROLES, ADMIN_ROLE, E_FORMAT, canonicalUserID } from "../services/roles";

/** Roles are keyed on the canonical E-format id. Re-enforced in guard G7. */
const userIDSchema = z.string().trim().toUpperCase().regex(E_FORMAT, "Must be an E-format NUSNET id");

/** z.enum, never z.string() — unknown strings die at the boundary. */
const roleSchema = z.enum(GRANTABLE_ROLES);

/**
 * Facilities require a DIFFERENT vocabulary than users are granted:
 * `resident` is requirable but not grantable, `admin` is grantable but must
 * never be stored as a requirement. min(1) removes the ambiguous empty state
 * from the write path entirely, since [] and missing-row now mean the same
 * thing (§0.1).
 */
const facilityRoleSchema = z.enum(FACILITY_ROLES);

/** Prisma's Mongo `contains` compiles to $regex. Unescaped user input is a
 *  catastrophic-backtracking vector, and role managers are students. */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const listInput = z.object({
  search: z.string().trim().max(100).optional(),
  role: roleSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
```

### Step 7.4 — Procedures

| Procedure | Gate | Notes |
|---|---|---|
| `whoAmI` | `protectedProcedure` | Returns identity + the capability set. **Must not** be `roleManagerProcedure` — the header calls it for every user, and a FORBIDDEN on every page load is not acceptable. |
| `listUsers` | `roleManagerProcedure` | Keyset paginated, searchable, role-filterable. |
| `getStats` | `roleManagerProcedure` | Admin count omitted when `!caps.seeAdminIdentities`. |
| `setUserRoles` | `roleManagerProcedure` | The one single-user mutation. Desired final set. |
| `explainAccess` | `roleManagerProcedure` | Evaluates a booking **as the target**, so an admin can see a non-admin outcome without holding a non-admin session. Audited (it is an enumeration primitive). |
| `systemHealth` | `roleManagerProcedure` | Counts for managers; per-user lists gated on `viewSystemHealthDetail`. |
| `setEnforcementMode` | `adminProcedure` | Writes the `SystemFlag` row. |
| `listAuditLog` | `adminProcedure` | |
| `listFacilityAccess` / `setFacilityAccess` | `adminProcedure` | A jcrc must not be able to gate every room behind `jcrc`, or open SCRC to everyone. |

```ts
export const adminRouter = createTRPCRouter({
  whoAmI: protectedProcedure.query(({ ctx }) => {
    const roles = ctx.session.user.roles ?? [];
    return {
      userID: ctx.session.user.userID,
      roles,                               // includes the stored "resident"
      capabilities: computeCapabilities(roles),
    };
  }),

  listUsers: roleManagerProcedure.input(listInput).query(async ({ ctx, input }) => {
    const caps = computeCapabilities(ctx.session.user.roles ?? []);
    const { search, role, limit, cursor } = input;

    /** D-2: a jcrc must not be handed an enumeration of who holds admin. */
    const redact = (roles: string[]) =>
      caps.seeAdminIdentities ? roles : roles.filter((r) => r !== ADMIN_ROLE);

    // ---- role-filtered branch: page the SMALL collection first -------------
    if (role) {
      if (role === ADMIN_ROLE) requireCapability(caps, "seeAdminIdentities");
      const roleRows = await ctx.db.userRole.findMany({
        where: { OR: [{ roles: { has: role } }, { role }] },   // legacy-tolerant
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
      });
      const page = roleRows.slice(0, limit);
      const nextCursor = roleRows.length > limit ? page[page.length - 1]?.id ?? null : null;

      // Hydrate. There is no reverse E-format -> email Mongo query, so probe
      // the conventional address and left-join in memory. A role may
      // legitimately exist for a user with no User row, so a miss renders as a
      // bare id, never as an omission.
      const emails = page.map((r) => `${r.userID.toLowerCase()}@u.nus.edu`);
      const users = await ctx.db.user.findMany({
        where: { email: { in: emails, mode: "insensitive" } },
        // NEVER a bare findMany: passwordHash must not reach the client, and
        // passwordHash-less Google rows would throw on a full read (I-2).
        select: { id: true, email: true, displayName: true, userID: true },
      });
      const byCanonical = new Map(users.map((u) => [canonicalUserID(u.email), u]));

      return {
        items: page.map((r) => {
          const u = byCanonical.get(r.userID);
          return {
            id: u?.id ?? r.id,
            canonicalUserID: r.userID,
            legacyUserID: u?.userID ?? null,
            email: u?.email ?? null,
            displayName: u?.displayName ?? null,
            hasAccount: Boolean(u),
            roles: redact(r.roles?.length ? r.roles : r.role ? [r.role] : []),
          };
        }),
        nextCursor,
      };
    }

    // ---- default branch: page User, batch the role lookup ------------------
    const esc = search ? escapeRegex(search) : undefined;
    const users = await ctx.db.user.findMany({
      where: esc ? { OR: [
        { email: { contains: esc, mode: "insensitive" } },
        { displayName: { contains: esc, mode: "insensitive" } },
      ]} : {},
      select: { id: true, email: true, displayName: true, userID: true, block: true },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: "asc" },
    });

    const page = users.slice(0, limit);
    const nextCursor = users.length > limit ? page[page.length - 1]?.id ?? null : null;

    const canonicalIDs = page.map((u) => canonicalUserID(u.email)).filter(Boolean);
    const roleRows = await ctx.db.userRole.findMany({ where: { userID: { in: canonicalIDs } } });
    const byID = new Map(roleRows.map((r) => [
      r.userID, r.roles?.length ? r.roles : r.role ? [r.role] : [],
    ]));

    return {
      items: page.map((u) => {
        const cid = canonicalUserID(u.email);
        return {
          id: u.id,
          canonicalUserID: cid,        // the key ALL mutations must submit
          legacyUserID: u.userID,      // DISPLAY ONLY — may be an A-format matric
          email: u.email,
          displayName: u.displayName,
          block: u.block,
          hasAccount: true,
          eligible: cid !== "",        // false => cannot sign in under D-7
          keyMismatch: Boolean(u.userID && u.userID !== cid),
          roles: redact(byID.get(cid) ?? []),
        };
      }),
      nextCursor,
    };
  }),

  getStats: roleManagerProcedure.query(async ({ ctx }) => {
    const caps = computeCapabilities(ctx.session.user.roles ?? []);
    const [totalUsers, jcrc, ccaHead, admins] = await Promise.all([
      ctx.db.user.count(),
      ctx.db.userRole.count({ where: { OR: [{ roles: { has: "jcrc" } }, { role: "jcrc" }] } }),
      ctx.db.userRole.count({ where: { OR: [{ roles: { has: "cca_head" } }, { role: "cca_head" }] } }),
      ctx.db.userRole.count({ where: { OR: [{ roles: { has: ADMIN_ROLE } }, { role: ADMIN_ROLE }] } }),
    ]);
    return { totalUsers, jcrc, ccaHead, admins: caps.seeAdminIdentities ? admins : null };
  }),

  setUserRoles: roleManagerProcedure
    .input(z.object({
      userID: userIDSchema,
      roles: roleSchema.array().max(8),
      reason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const { actorRoles, before, after, added, removed } = await assertCanMutateRoles({
        db: ctx.db, actorUserID, targetUserID: input.userID, requestedRoles: input.roles,
      });
      // `added`/`removed` are the authorised DELTA and must be threaded
      // through: applyRoleChange asserts on `removed` (I-8c) and the caller
      // must not be able to skip that by passing only `after`.
      const result = await applyRoleChange({
        db: ctx.db, actorUserID, actorRoles,
        targetUserID: input.userID, before, after, added, removed,
        reason: input.reason,
      });
      return { userID: input.userID, roles: result };
    }),

  /**
   * Closes the "admin bypass masks everything" testing hole: canBookWithRoles
   * returns true for admin before consulting requirements, so the person
   * running the rollout cannot reproduce any resident-side failure from their
   * own session. Audited because it is an enumeration primitive over the whole
   * user base.
   */
  explainAccess: roleManagerProcedure
    .input(z.object({ userID: userIDSchema, facilityID: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const { evaluateBooking, getFacilityRequiredRoles } = await import("../services/access");
      const [decision, requiredRoles, roles] = await Promise.all([
        // No email argument, deliberately: this evaluates AS the target, and
        // inspecting a user must not mint them a baseline as a side effect.
        // It therefore shows the target's REAL stored state, which is exactly
        // what makes it useful for triaging a NOT_RESIDENT report.
        evaluateBooking(ctx.db, input.userID, input.facilityID),
        getFacilityRequiredRoles(ctx.db, input.facilityID),
        getUserRoles(ctx.db, input.userID),
      ]);
      await writeAudit(ctx.db, {
        actorUserID: ctx.session.user.userID,
        actorRoles: ctx.session.user.roles ?? [],
        targetUserID: input.userID, targetFacilityID: input.facilityID,
        action: "explainAccess",
      });
      return { decision, requiredRoles, roles };
    }),

  /**
   * The detection surface. Aggregate counts for managers; per-user identifier
   * lists (ineligible accounts, canonical-id collisions, passwordHash-less
   * rows) are account-integrity data and are admin-only.
   */
  systemHealth: roleManagerProcedure.query(async ({ ctx }) => {
    const caps = computeCapabilities(ctx.session.user.roles ?? []);
    const [facilities, access, mode, shadow24h, baselineMissing] = await Promise.all([
      ctx.db.facilities.findMany({ select: { facilityID: true, facilityName: true } }),
      ctx.db.facilityAccess.findMany({ select: { facilityID: true, requiredRoles: true } }),
      (await import("../services/flags")).getEnforcementMode(ctx.db),
      ctx.db.roleAuditLog.count({ where: {
        action: "booking.denied.shadow",
        at: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
      }}),
      // RED LINE, not a materialization gap. Scoped to NUS-emailed User rows
      // ONLY: counting ineligible accounts (test@, aaaaaa@) makes a number
      // that can never reach zero, and per I-16's corollary a gate that cannot
      // reach zero gets muted — which deletes the detector. Compare the
      // ELIGIBLE population against stored baselines and name the offenders.
      (async () => {
        const eligible = await ctx.db.user.count({
          where: { email: { mode: "insensitive", contains: "@u.nus.edu" } },
        });
        const held = await ctx.db.userRole.count({ where: { roles: { has: "resident" } } });
        return Math.max(0, eligible - held);
      })(),
    ]);
    const configured = new Set(access.map((a) => a.facilityID));
    const unconfigured = facilities.filter((f) => f.facilityID !== -1 && !configured.has(f.facilityID));
    return {
      enforcementMode: mode,
      shadowDenials24h: shadow24h,
      facilities: facilities.length,
      unconfiguredFacilities: unconfigured.length,
      /**
       * RED LINE. Under the stored baseline a non-zero value is a LIVE
       * LOCKOUT of that many eligible users, not an advisory materialization
       * gap. Do not flip enforcement to `enforce` while it is non-zero.
       * (`05-verification.md` §7's standing daily query carries the same
       * promotion from advisory to blocking.)
       */
      residentBaselineMissing: baselineMissing,
      /**
       * Count of baseline repair failures observed in the last 24h, from the
       * structured `baseline_repair_failed` log if it is shipped to a
       * queryable sink; otherwise grep the platform logs for that evt. This is
       * the ONLY detector for L-6, the design's single honest residual, so it
       * must not be silently dropped from this panel.
       */
      baselineRepairFailures24h: /* see §2.5 */ null,
      adminRolesStoredOnFacilities: access.filter((a) => a.requiredRoles?.includes("admin")).length,
      detail: caps.viewSystemHealthDetail ? { unconfigured } : null,
    };
  }),

  setEnforcementMode: adminProcedure
    .input(z.object({
      mode: z.enum(["off", "permissive", "enforce"]),
      reason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.systemFlag.upsert({
        where: { key: "rbac.booking.enforcement" },
        create: { key: "rbac.booking.enforcement", value: input.mode,
                  updatedAt: new Date(), updatedBy: ctx.session.user.userID },
        update: { value: input.mode, updatedAt: new Date(), updatedBy: ctx.session.user.userID },
      });
      await writeAudit(ctx.db, {
        actorUserID: ctx.session.user.userID,
        actorRoles: ctx.session.user.roles ?? [],
        action: "enforcement.set", reason: input.reason,
        rolesAfter: [input.mode],
      });
      // Takes effect within the 15s per-lambda cache TTL. No redeploy.
      return { mode: input.mode };
    }),

  listAuditLog: adminProcedure
    .input(z.object({
      targetUserID: userIDSchema.optional(),
      actorUserID: userIDSchema.optional(),
      action: z.string().max(32).optional(),
      batchId: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.roleAuditLog.findMany({
        where: {
          ...(input.targetUserID ? { targetUserID: input.targetUserID } : {}),
          ...(input.actorUserID ? { actorUserID: input.actorUserID } : {}),
          ...(input.action ? { action: input.action } : {}),
          ...(input.batchId ? { batchId: input.batchId } : {}),
        },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { at: "desc" },
      });
      const page = rows.slice(0, input.limit);
      return { items: page, nextCursor: rows.length > input.limit ? page[page.length - 1]?.id ?? null : null };
    }),

  listFacilityAccess: adminProcedure.query(async ({ ctx }) => {
    const [facilities, access] = await Promise.all([
      ctx.db.facilities.findMany({ orderBy: { facilityID: "asc" } }),
      ctx.db.facilityAccess.findMany(),
    ]);
    const byID = new Map(access.map((a) => [a.facilityID, a]));
    return facilities.map((f) => {
      const a = byID.get(f.facilityID);
      const stored = a?.requiredRoles?.length
        ? a.requiredRoles
        : a?.requiredRole ? [a.requiredRole] : [];
      return {
        facilityID: f.facilityID,
        facilityName: f.facilityName,
        requiredRoles: stored.length ? stored : ["resident"],
        /** True = never configured. Under D-1 it defaults to resident, so this
         *  is a config gap to surface, not a lockout. */
        unconfigured: !a,
      };
    });
  }),

  setFacilityAccess: adminProcedure
    .input(z.object({
      facilityID: z.number().int(),
      /**
       * min(1): [] and missing-row are now the SAME state, so an empty payload
       * is ambiguous and is rejected at the boundary. "Open to everyone" no
       * longer exists — the least restrictive setting is ["resident"].
       * `admin` is absent from FACILITY_ROLES: it is an implicit bypass.
       */
      requiredRoles: facilityRoleSchema.array().min(1).max(8),
    }))
    .mutation(async ({ ctx, input }) => {
      const facility = await ctx.db.facilities.findUnique({ where: { facilityID: input.facilityID } });
      if (!facility) throw new TRPCError({ code: "NOT_FOUND", message: "Facility not found" });

      const existing = await ctx.db.facilityAccess.findUnique({ where: { facilityID: input.facilityID } });
      const before = existing?.requiredRoles?.length
        ? existing.requiredRoles
        : existing?.requiredRole ? [existing.requiredRole] : [];
      const roles = [...new Set(input.requiredRoles)];

      await ctx.db.facilityAccess.upsert({
        where: { facilityID: input.facilityID },
        // The legacy mirror is set to "" on INSERT and left untouched on
        // UPDATE. Rationale: a newly created row must read as falsy to the
        // still-deployed pre-v2 access.ts (preserving today's open-by-default),
        // while an existing gated row (SCRC) keeps its real legacy value so a
        // revert does not silently un-gate it. The sentinel is "" and not null
        // because the old deployed client throws on absence and on null (01
        // §0.1). Doc 06 drops the field.
        create: { facilityID: input.facilityID, requiredRoles: roles, requiredRole: "",
                  updatedAt: new Date(), updatedBy: ctx.session.user.userID },
        update: { requiredRoles: roles,
                  updatedAt: new Date(), updatedBy: ctx.session.user.userID },
      });

      await writeAudit(ctx.db, {
        actorUserID: ctx.session.user.userID,
        actorRoles: ctx.session.user.roles ?? [],
        targetFacilityID: input.facilityID,
        action: "facilityAccess.set",
        rolesBefore: before, rolesAfter: roles,
      });
      return { facilityID: input.facilityID, requiredRoles: roles };
    }),

  // Bulk procedures: see §8.
});
```

### Error hygiene

Wrap the router so a raw Prisma error never reaches a jcrc-level user (it leaks collection names, field names and index details). In `src/server/api/trpc.ts`'s `errorFormatter`, or as a middleware on `roleManagerProcedure`, convert any non-`TRPCError` throwable to `INTERNAL_SERVER_ERROR` with a fixed message. The client renders `error.message` only for `FORBIDDEN`, `PRECONDITION_FAILED`, `NOT_FOUND` and `BAD_REQUEST`.

---

## 8. Bulk operations and deferred grants (D-8) — backend surface

Doc `03-admin-dashboard.md` owns the wizard UI, the CSV parser and the column mapper; doc `01-data-model.md` owns the `BulkRoleImport` and `PendingRoleGrant` models. This section owns the **procedures and their guarantees**.

**Transport.** `previewBulkImport` is a **`.mutation()`, not a `.query()`**. `src/trpc/react.tsx` uses `unstable_httpBatchStreamLink` with no `methodOverride`, so queries are GET with the input serialized into the querystring; 1000 CSV rows is ~1 MB of URL and 414s well before ten realistic rows. The no-write property is preserved structurally instead: the procedure body opens no transaction and passes `dryRun: true` to every guard call.

**Chunking.** `commitBulkChunk` caps at **25 rows**. At ~5 Atlas round-trips per row (role read, guard read, transaction, audit) at ~60 ms, 25 rows is ~7.5 s against a Vercel default ceiling of 10–15 s. Also `export const maxDuration = 60;` from the tRPC route handler. The client loops chunks under one `batchId` from `beginBulkImport`, and `commitBulkChunk` returns the last successfully processed `lineNo` so a truncated chunk resumes rather than retrying blind.

**Guards apply per row, never per batch.** Every row runs the full `assertCanMutateRoles` → `applyRoleChange` pair independently, so a jcrc's import containing one admin returns `CANNOT_MODIFY_AN_ADMIN` for that row and succeeds on the other 24. **This is also what makes bulk sticky (I-8c):** there is no second write path, so replace-mode's safety comes from the §6 chokepoint, not from the client's `computeAfter` helper — that helper exists only so the preview's `After` column matches what the server will do. The same applies to **bulk undo**, which is a normal guarded role change per row and therefore cannot express removing `resident` either. Partial failure is the expected outcome, not an error condition. This is why `commitRowSchema.userID` is a **plain bounded string, not `userIDSchema`** — zod validates the whole input object, so one malformed id in an E-format-regex field would 400 the entire chunk; non-canonical ids are rejected per row by G7 as `NOT_A_CANONICAL_USERID`.

**Optimistic concurrency.** Each committed row carries `expectedBefore` from the preview. At commit, if the target's current grantable role set differs, that row returns `CONFLICT_ROLES_CHANGED` and is audited as `action:"denied"` — a silently skipped row must not be indistinguishable from one that was never submitted.

**Identifier resolution** (`src/server/api/services/identityResolver.ts`, new) builds an in-memory index of all ~515 users and resolves in strict tier order: `@u.nus.edu` email → E-format NUSNET id → A-format matric (`UserMatric`, **not unique**, so ≥2 hits is `ambiguous`) → display name (`User.displayName` is nullable and non-unique, so this is `confidence: "low"`, excluded from commit by default). Build the index with an explicit `select` — a bare `findMany` reads `passwordHash` and throws on Google-adapter rows. Skip any user whose `canonicalUserID` is `""`, so a non-NUS row can never enter the index and be resolved onto.

**The low-confidence gate must be server-enforced.** `confirmed: boolean` from the client is not evidence. `previewBulkImport` returns a short-TTL HMAC over `(batchId, actorUserID, [{userID, rolesAfter, via, confidence}])`; `commitBulkChunk` requires it and rejects any row whose tuple is not in the signed plan, and rejects `via: "name"` rows unless the confirmation is inside the signed payload. Without this, a caller posts straight to `commitBulkChunk` and every ambiguous name-match commits — `expectedBefore` is not a secret, it is just the target's current roles, obtainable from `listUsers`.

**Pending grants are keyed ONLY on a canonical E-format userID** derived from an explicit E-id or an `@u.nus.edu` email. Never a matric — `UserMatric.matric` is self-asserted (`src/server/api/routers/user.ts:85-99` upserts whatever the logged-in user types), so a matric-keyed grant is claimable by anyone who types that matric. Never a display name. Creation rules, enforced server-side and not only in the UI:

1. `resident` → reject (`RESIDENT_IS_NEVER_DEFERRED`). It is not in `GRANTABLE_ROLES` so the schema cannot express it in the first place (I-8e); the rule is restated here because a deferred grant is the one payload someone might reach for when a user "has no resident row yet" — that case is I-8a/I-8b's, not this one's.
2. Every role must be in `assignableBy(actorRoles)` — a jcrc creating a pending `jcrc` is refused (D-3).
3. `admin` requires `caps.seeAdminIdentities`, a non-empty `reason`, and `expiresInDays ≤ 14`. A pending grant is a bearer credential against a mailbox nobody has claimed yet; the shorter it lives, the smaller the window.
4. If a `User` row already exists → refuse with `USER_EXISTS_GRANT_DIRECTLY`. The §2.5 fast path only fires at true first login, so a grant created after signup would be stranded.
5. Upsert on `userID @unique`, unioning roles and taking the later expiry.
6. One `RoleAuditLog` row per grant, `action: "pending.create"`.

Redemption re-authorizes (§2.5): the granter's *current* roles are re-read and any role they can no longer assign is dropped and recorded.

**Preview is a directory-disclosure surface.** `previewBulkImport` is `roleManagerProcedure` and accepts up to 1000 operator-supplied identifiers, returning each match's email, displayName, block and full role set. For non-admin viewers, redact `admin` from `rolesBefore`/`rolesAfter` (surface such rows as `denied / CANNOT_MODIFY_AN_ADMIN` with no role enumeration), mask `email` for rows where the operator did not themselves supply the email, and rate-limit per actor per hour using the existing `src/lib/rateLimit.ts`.

Procedure list (signatures in doc 03; gates here):

| Procedure | Gate | Capability |
|---|---|---|
| `previewBulkImport` (mutation) | `roleManagerProcedure` | `bulkAssign` |
| `beginBulkImport` | `roleManagerProcedure` | `bulkAssign` |
| `commitBulkChunk` | `roleManagerProcedure` | `bulkAssign`; re-checks `batchId.actorUserID === ctx.session.user.userID` |
| `finishBulkImport` | `roleManagerProcedure` | tallies computed **server-side** from `RoleAuditLog`, never accepted from the client |
| `listBulkImports` / `getBulkImport` | `roleManagerProcedure` | `bulkAssign` |
| `undoBulkImport` | `roleManagerProcedure` | `undoBulkImport`; runs the normal guards per row, so a jcrc cannot undo an admin-granting import |
| `createPendingGrants` | `roleManagerProcedure` | `createPendingGrants` |
| `listPendingGrants` / `revokePendingGrant` | `roleManagerProcedure` | admin-bearing rows hidden unless `seeAdminIdentities` |
| `purgeExpiredPendingGrants` | `adminProcedure` | — |

Undo selects `{ batchId, ok: true, action: { in: ["set", "pending.claim"] } }` and reverses in **descending** `at` order, skipping any target whose current roles have diverged (`DIVERGED_SINCE_IMPORT`) rather than silently reverting a later deliberate change. Undo is itself an import with its own `batchId`; the log is append-only.

---

## 9. Adjacent holes this phase touches but does not close

Flagged so they can be scoped separately. Each is now trivially expressible.

- `facilitiesBooking.ts` `forceBook` is an unguarded client boolean — any user can double-book over anyone. Should be `admin || jcrc`.
- `getBookings` accepts an arbitrary `userId` filter with no authorization; any authenticated user can enumerate another user's bookings.
- `createBooking` accepts `ccaID` from the client with no membership check (`facilitiesBooking.ts:296`, written at `:360`; `BookingModal.tsx:92` hardcodes `0`). Under D-1, CCA rooms become `cca_head`-gated while `ccaID` stays unvalidated, so a legitimate head can attribute a booking to a CCA they have nothing to do with. **This is the exact seam the future CCA system needs** — doc `07-cca-future.md` records that the eventual check is `ccaID === 0 || caller heads ccaID`, applied at `facilitiesBooking.ts:360`. Note also that `cascade.ts:28` deletes `Bookings` by `ccaID`, so a `CCA` row with `ccaID: 0` would wipe every booking — verify none exists.
- `post.create` writes `Posts.isOfficial` with no role check. Should be `matricProcedure.use(requireRoles("jcrc"))`.
- **`cca_head` is a flat capability in this phase.** Per D-1 there is deliberately no per-CCA ownership check: any `cca_head` books any CCA-gated room. `CcaHead` (doc 01) is **not consulted** by any code in this document. The single function that will start consulting it is `canBookWithRoles` in `src/server/api/services/access.ts`, gaining a `ccaID?: number` parameter. Doc `07-cca-future.md` owns that change and any succession flow; nothing here has to be migrated away from.

---

## 10. Deployment order

1. Verify all four blocking gates in §0.2.
2. Set the flag **off** before any code ships: `SystemFlag{ key: "rbac.booking.enforcement", value: "off" }`.
3. Deploy everything in §§1–8 with `RBAC_BOOKING_ENFORCEMENT=off`. **Booking behaviour is byte-identical to today** — mode `off` is legacy semantics, so SCRC stays gated and everything else stays open. The only user-visible changes are the D-7 sign-in restriction and disabled options in the booking picker.
4. Smoke test (§11), including from a **second, non-admin NUS account** — the admin bypass in `canBookWithRoles` means testing from `E1633673` verifies nothing.
5. `setEnforcementMode("permissive")`. Live within 15s.
6. Soak ≥72 hours spanning a weekday and a weekend. Read `booking.denied.shadow` daily. Target: zero `NOT_RESIDENT`, every `ROLE_REQUIRED` explainable as a genuine gated-room attempt. Any `NOT_RESIDENT` → stop, run the userID through `explainAccess`, fix, restart the clock.
7. **Pre-flip baseline gate (new under the stored design).** Re-run `scripts/remediation/backfill-resident.mjs` immediately before flipping, to catch anyone created in the soak window. It must print `MISSING 0` **and** `modified 0, upserted 0` — the set difference alone cannot detect a broken grant point, because the re-run's own `$addToSet` closes the gap it was supposed to measure. Any non-zero `modified`/`upserted` means G-A or G-B (§2.6) is broken; the flip is blocked pending an explanation. `admin.systemHealth.residentBaselineMissing` must read 0 in the same window.
8. `setEnforcementMode("enforce")`. Announce it. Watch the denial log for the first hour.
9. **Revert = `setEnforcementMode("off")`.** One mutation, no deploy, live in 15s.
10. Legacy scalar drop: doc `06-legacy-cutover.md`. Do not bundle. **Remove `$setOnInsert: { role: "" }` from `ensureBaseline` in that same commit** (§6).

---

## Done when

**Compiles and is internally consistent**
- [ ] `npx tsc --noEmit` clean, including the `Session["user"]` augmentation with `eligible`, `roles`, `isAdmin`.
- [ ] `getUserRole` (singular) appears nowhere in `src/`.
- [ ] `normalizeRoles` and `effectiveRoles` appear nowhere outside `roles.ts` (both are replaced by `normalizeStoredRoles`, which takes no `userID`).
- [ ] `isResidentEligible` appears nowhere — it is renamed `isCanonicalResidentID`, and `ensureBaseline` takes an **email**, never an id.
- [ ] I-8a grep gate: `grep -rnE 'user\.create|user\.createMany|user\.upsert|createUser|insert:\s*"User"' src/ scripts/` — every hit is a §2.6 grant point or carries a comment saying why not.
- [ ] I-8b companion gate: `grep -rn "getUserRoles\|isAdmin(" src/app/api/ src/server/` — every call site runs after `auth()` or calls `ensureBaseline` itself.
- [ ] AST gate: no Prisma `data:` object in `services/` or `routers/` carries a `roles` key except the single guarded upsert in `roleService.ts`.
- [ ] `src/lib/identity.ts` imports neither `~/server/db` nor `~/env`, and an eslint rule enforces it.
- [ ] `scripts/remediation/lib/identity.mjs` parity test passes over all 11 fixtures.
- [ ] No component branches on `roles.includes("admin")`; every gate reads `whoAmI().capabilities`.
- [ ] Grep: no `getAllFacilities` call site decides whether a booking control is enabled.

**D-7 sign-in**
- [ ] Register at `attacker@gmail.com` → 400 naming `@u.nus.edu`.
- [ ] Register at `E1633673@U.NUS.EDU` (uppercase) → **201**. Regression test for the live lowercase bug.
- [ ] Credentials login with a pre-existing non-NUS row → fails, no session cookie set.
- [ ] Direct-navigate `/api/auth/signin/google` with a personal Gmail → redirected to `/login?error=AccessDenied`, and `db.user.count()` is **unchanged** (proves `signIn` ran before `callbackHandler`).
- [ ] `g.s_samuel@u.nus.edu` (non-E-format NUS localpart) signs in; `session.user.userID === "G.S_SAMUEL"`; `roles` contains `resident`.
- [ ] A session minted before the deploy on an ineligible address: `eligible === false`, `roles: []`, `userID: ""`, every `protectedProcedure` returns `NUS_ACCOUNT_REQUIRED`, and the user reaches an explanatory page with a working sign-out (doc 03) — **not** the matric onboarding loop.

**Session and the stored resident baseline**
- [ ] `/api/auth/session` as the admin shows `"roles":["admin","resident"]`, `"isAdmin":true` — roles STACK; admin is not an alternative to resident.
- [ ] Register a brand-new NUS account (G-A) → a `UserRole` row exists with `roles: ["resident"]` and `role: ""` **before the first login**.
- [ ] Delete that row by hand, then load any page → the row is recreated with `resident` **on that same request**, and the request's own authorization sees it (book a normal room in the same session without re-logging-in). This is I-8b and it is the clearest single proof of the design.
- [ ] Plant a `UserRole` row with `roles: ["jcrc"]` and no `resident`, then load a page → `roles` becomes `["jcrc","resident"]`; the `jcrc` grant is not disturbed.
- [ ] Steady state issues zero extra reads and zero writes from the session callback: log in twice; confirm `baseline_repair_failed` and `pending_grants_failed` are absent, no `UserRole` write occurred on the second read, and **no `PendingRoleGrant` query occurred either** (proves `pendingCheckedAt` was stamped unconditionally on the first pass, including the no-grants case).
- [ ] Concurrency: fire N simultaneous session reads for a user with no row → exactly one `UserRole` document exists afterwards, with exactly one `"resident"` entry, and no request 500s.
- [ ] A ""-canonical session (non-NUS legacy JWT) performs **no** `userRole` lookup and **no** `ensureBaseline` call, and resolves to `roles: []` even with a planted `UserRole` document keyed on `""`.
- [ ] `admin.systemHealth.residentBaselineMissing` reads **0** before the `enforce` flip, and its query counts only NUS-emailed `User` rows (a `test@`/`aaaaaa@` row must not make it un-zeroable).
- [ ] Simulate a `UserRole`-scoped write failure → `baseline_repair_failed` is logged with the userID, the deny still occurs, **and** the circuit breaker limits it to one write attempt per lambda per window rather than two per request.

**Booking authz**
- [ ] Mode `off`: SCRC Room is still gated to jcrc; every other room is still open to all. Byte-identical to pre-deploy.
- [ ] Mode `enforce`, plain resident: normal room succeeds; SCRC returns FORBIDDEN with a message naming `jcrc`, not a bare "not allowed".
- [ ] Mode `enforce`, jcrc: SCRC succeeds. cca_head: a CCA-gated room succeeds.
- [ ] Mode `permissive`: the same denial succeeds **and** writes a `booking.denied.shadow` row with the correct `denyReason`.
- [ ] `setEnforcementMode` takes effect within 15s with no redeploy.
- [ ] `getFacilitiesForBooking` returns `canBook: false` + `requiredRoles` for rooms the caller cannot book.
- [ ] `updateBooking` on a gated facility by a user who has lost the role returns FORBIDDEN when times change.
- [ ] `admin.explainAccess({ userID: <non-admin>, facilityID })` returns that user's real decision while called by an admin.

**Escalation guards** (each returns FORBIDDEN **and** writes a `RoleAuditLog` row with `ok:false` and the named `denyReason`)
- [ ] As jcrc, `setUserRoles` on a target holding `admin` → `CANNOT_MODIFY_AN_ADMIN` (G3).
- [ ] As jcrc, grant `jcrc` → `CANNOT_GRANT_JCRC` (**D-3 — this INVERTS the v1 test, which expected success**).
- [ ] As jcrc, grant `admin` → `CANNOT_GRANT_ADMIN`.
- [ ] As jcrc, revoke `jcrc` from another user → `CANNOT_REVOKE_JCRC_FROM_OTHERS`.
- [ ] Target with an A-format matric → `NOT_A_CANONICAL_USERID` (G7).
- [ ] Non-admin self-granting a role they lack → `CANNOT_SELF_ASSIGN` (G6).
- [ ] Revoking the last admin → `CANNOT_REMOVE_LAST_ADMIN`.
- [ ] Self-revoking admin → `CANNOT_SELF_REVOKE_ADMIN`.
- [ ] `setUserRoles` with `roles: ["resident"]` → rejected by zod at the boundary (`resident` is not in `roleSchema`), proving the baseline is unexpressible.
- [ ] `setUserRoles` with `roles: []` on a resident → **`db.UserRole.findOne({userID}).roles` still CONTAINS `"resident"`.** Assert against the STORED ROW, not the session read: under I-8 the row is the truth, and a session-level assertion would have passed under the old derivation even while the row was being stripped. Repeat for a grant→revoke round trip and for a bulk-undo row.
- [ ] Two simultaneous `setUserRoles` on the same target (one grant, one revoke) → one succeeds and one returns `CONFLICT_ROLES_CHANGED`; the result is never a merged state, and no audit row claims a `rolesAfter` that never existed.
- [ ] Two simultaneous admin self-revocations → exactly one succeeds; at least one admin remains. (This is the test that catches anyone converting the §6 write to `$runCommandRaw`, which would leave the transaction.)
- [ ] `legacyMirror([])` returns `""`, not `null`/`undefined` (I-9 sentinel on the insert branch).
- [ ] `setFacilityAccess` with `requiredRoles: []` → rejected by zod (`min(1)`).
- [ ] `setFacilityAccess` with `requiredRoles: ["admin"]` → rejected (`admin` absent from `FACILITY_ROLES`).

**Bulk and deferred (D-8)**
- [ ] A 1000-row preview completes with no 413/414 (it is a POST).
- [ ] A 500-row commit completes; every chunk returns under `maxDuration`; a killed chunk resumes from the returned `lineNo` rather than double-applying.
- [ ] A 25-row chunk containing one admin target: that row fails, the other 24 succeed, all 25 share one `batchId`.
- [ ] Previewing 500 rows including 40 denials writes **zero** `RoleAuditLog` rows.
- [ ] Changing a target's roles between preview and commit → that row returns `CONFLICT_ROLES_CHANGED` and is audited.
- [ ] Posting to `commitBulkChunk` with a forged/absent plan token → rejected.
- [ ] Pending grant for an unsigned-up E-id → sign that account up → roles present on the first session read, `PendingRoleGrant` row gone, `pending.claim` audited **with the originating `batchId`**.
- [ ] Pending grant created by a jcrc who is then demoted → on redemption the role is dropped and the drop is recorded in the audit `reason`.
- [ ] Undo an import in which some pending grants were already claimed → claimed roles are reversed too, **every affected `UserRole` row still contains `"resident"` when read directly from the database**, unclaimed rows are deleted, counts reported separately.
- [ ] A 25-row replace-mode bulk import against targets who all hold `resident` → all 25 stored rows still contain it afterwards. This is the mode that most needed a real mechanism; assert it on the rows, not on the preview.
- [ ] `previewBulkImport` as a jcrc never returns `admin` in any row's role list.

**Cross-document**
- [ ] Doc `05-verification.md` line 225 ("Decide D-7") is deleted — D-7 is implemented here, not deferred.
- [ ] Doc `00-overview.md`'s permission matrix rows for "Grant `jcrc`" and "Book an ungated facility" match §0 and §6.
