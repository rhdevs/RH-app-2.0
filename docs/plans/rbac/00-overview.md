**Status:** v2. Supersedes v1 in full. All eight open decisions (D-1 … D-8) are answered and binding. Read this document before any other; it is the only one that states the role vocabulary, the semantics, the invariants and the ordering. Every other document assumes them.

**Document set.** `00-overview.md` (this) · `01-data-model.md` · `02-backend-authz.md` · `03-admin-dashboard.md` · `04-profile-page.md` · `05-verification.md` · `06-legacy-cutover.md` (new) · `07-cca-future.md` (new).

---

## 1. Goals

1. Introduce persisted roles: `admin`, `jcrc`, `cca_head`, plus an auto-assigned, **stored** baseline role `resident` held by every eligible account.
2. Grant `admin` to `E1633673` (verified empirically, not assumed — `01-data-model.md` step 1).
3. **Restrict sign-in to `@u.nus.edu`** (D-7). This is a prerequisite for everything else, not a follow-up.
4. **Make booking role-driven end to end** (D-1). Normal rooms require `resident`; SCRC requires `jcrc`; CCA rooms require `cca_head`. There is no longer an "open to everyone" facility state.
5. One `/admin` dashboard shared by `admin` and `jcrc`, driven by a **server-computed capability set**, never an `isAdmin` fork (D-2).
6. JCRC may book every room and may manage `cca_head`. **JCRC may not grant or revoke `jcrc`** (D-3, reversing v1).
7. Bulk role operations as a first-class feature: CSV/paste import, identifier resolution, dry-run preview, per-row results, deferred grants for people who have not signed up (D-8).
8. Users can see and edit their profile.
9. **Complete the transition**: the legacy scalar `role` / `requiredRole` fields are dropped, on a planned cutover with backup, verification and restore (D-6, reversing v1).
10. Design so the future CCA management system requires no migration away from anything built here (new scope).

Non-goals, stated so they are not accidentally built: the CCA management system itself; per-CCA scoping of `cca_head` for booking; self-serve head-initiated handover; a `suspended` sanction (see §3.4).

---

## 2. Role model

### 2.1 Multi-role, array on one document (unchanged from v1, still correct)

`UserRole.role String` becomes `UserRole.roles String[]`, keeping `userID @unique` — one document per user.

**Why multi-role.** A person is plausibly both `jcrc` and `cca_head`. Under single-role you pick one at grant time and lose the other silently. `src/server/api/services/access.ts:39` already carries the decay signature of single-role — `role === required || role === ADMIN_ROLE`, a hardcoded one-level hierarchy needing another `||` per role.

**Why an array on one document, not one row per (user, role).**

- The session callback (`src/server/auth.ts:132-154`) does one indexed `findUnique` per session read for `userMatric`, with an in-file comment justifying that cost. An array keeps roles at one more `findUnique`. A junction table makes it a `findMany` returning N documents on the hottest path in the app.
- "Set this user's roles to exactly X" is one atomic single-document update. With a junction table it is a non-atomic `deleteMany` + `createMany`; a crash mid-way leaves zero or duplicated roles.
- `userID @unique` is already the invariant we want. The junction encoding requires dropping it — and `UserCCA` in this same schema (`prisma/schema.prisma:364-369`) demonstrates what happens when the replacement compound unique is forgotten: it has none, so duplicate memberships are possible today.
- Per-grant provenance belongs in `RoleAuditLog`, which also records revocations. A junction row cannot.

**`FacilityAccess.requiredRole String` must become `requiredRoles String[]`.** A single string cannot express "jcrc OR cca_head may book this room", and `facilityID @unique` forbids multiple rows per facility. This is a hard blocker, not a nicety.

### 2.2 The four roles

| Role | Stored? | Who holds it | Grantable via `/admin`? |
|---|---|---|---|
| `resident` | **Yes** — auto-assigned to every eligible account at creation, self-healed at login | every sign-in-eligible account, automatically, **including admins, jcrc and cca_head** | **No** — see §2.3 |
| `cca_head` | Yes, plus a scoped `CcaHead` row | CCA heads | Yes, but **only** via the dedicated CCA endpoints (§2.5) |
| `jcrc` | Yes | JCRC committee | Yes, **admin only** (D-3) |
| `admin` | Yes | system administrators | Yes, admin only |

`admin` is an implicit **bypass** for facility gating: it is never stored in `requiredRoles`. Storing it invites someone to edit the array, drop `"admin"`, and lock admins out of a room.

The v1 pseudo-role `"user"` is **deleted from the vocabulary**. Under D-1 there is no capability that an authenticated account holds by virtue of being authenticated; the floor is `resident`, and every account — including admins, jcrc and cca_head — **stores** it. Roles stack; `resident` is the floor, never an alternative.

### 2.3 `resident` is STORED and auto-assigned — the load-bearing decision of this revision

D-1 says every verified `@u.nus.edu` account is auto-granted `resident` on login. v2 built that by *deriving* it at the read boundary and treating the `UserRole` write as advisory. **That decision is repealed by explicit user instruction** ("resident should be automatically assigned, so everyone technically has the resident role even admin and others"). `resident` is now real, stored data: it is written into `UserRole.roles` at account creation, backfilled authoritatively to all ~515 current members, and read — not recomputed — by authorization.

Storing it re-opens every lockout mode that derivation closed for free. They are re-closed by mechanism instead, and the mechanisms rest on one verified structural property:

> **Every authoritative role check in this application is preceded, in the same request, by a run of the NextAuth `session` callback.** `createTRPCContext` calls `await auth()` on every tRPC request (`src/server/api/trpc.ts:30`), and `auth()` is `getServerSession(authOptions)` under the JWT strategy with no server-side session cache (`src/server/auth.ts:168-175`), so `callbacks.session` runs every time.

A repair placed inside that callback therefore runs **before** anything can consume the baseline. Derivation made the baseline unconditionally true; storage makes it *true-and-repaired*. Three mechanisms, and only these three, keep the stored value true — remove any one and a lockout class re-opens that the other two do not cover:

1. **Grant at creation (I-8a).** Every path that creates a `User` grants the baseline in the same request: the credentials register route, the NextAuth `events.createUser` hook, and the merge/dedupe scripts. Enumerated in `02-backend-authz.md`; adding an unenumerated creation path is a silent lockout of every account it creates.
2. **Self-heal at session read (I-8b).** `ensureBaseline()` is an idempotent `$addToSet` upsert fired from the session callback only when the stored set lacks the baseline. Steady state it issues **zero** reads and zero writes; on the cold path it is awaited so the same request sees the repaired set. A user created before this ships, mis-keyed by a backfill, hand-deleted, or restored from a stale backup repairs themself on their next page load.
3. **Sticky at every write (I-8c).** The single write chokepoint emits `$pull(removed)` + `$addToSet(added)` where `removed ⊆ GRANTABLE_ROLES`, and `resident ∉ GRANTABLE_ROLES`. The baseline is not *filtered out* of a removal payload — it is **incapable of entering one**.

The read boundary no longer discards-and-re-derives. It normalizes:

```ts
// src/server/api/services/roles.ts — the read boundary. Every consumer goes through it.
export function normalizeStoredRoles(
  stored: readonly string[] | null | undefined,
): Role[] {
  // KEEPS "resident" — it is now a known, valid, stored member of ROLES.
  // Drops unknown strings only. There is no re-derivation step: the stored
  // value IS the authorization input (I-8).
  return [...new Set((stored ?? []).filter(isKnownRole))];
}
```

Consequences you must not fight:

- `resident` is **not** in `GRANTABLE_ROLES` and **not** in `roleSchema`. It is unrepresentable in any grant, revoke, set, bulk or deferred payload — but the *justification has inverted*: absence from those schemas no longer makes it inexpressible-because-derived, it **protects the stored value from removal**. Adding it there would make a 515-user mass-strip expressible in a single bulk payload.
- `resident` is **not revocable through the role UI**, and a manual database revocation is not a sanction either — I-8b repairs it at the target's next page load. See §3.4 for what a booking ban would actually require.
- The write **is** authoritative. The three mechanisms above are what make it reliable. `isCanonicalResidentID()` is no longer an authorization input; it is part of a **write guard** — it decides who may *receive* the baseline, never who *has* it.
- `RoleBadges` renders `resident` as a read-only badge, never a checkbox (`04-profile-page.md`, `03-admin-dashboard.md`). It is now read-only because it is ungrantable, not because it is derived.

### 2.4 Eligibility is one predicate, shared with the sign-in gate (D-7 × D-1)

The sign-in restriction and the baseline eligibility test **must be the same function**, or a gap opens in one direction or the other. Both derive from one anchored transform, in one pure module.

```ts
// src/lib/identity.ts — pure. No Prisma, no env, no next/server: safe to import
// from route handlers, auth callbacks, tRPC services AND client components.
// (Deliberately NOT src/server/identity.ts: src/app/login/page.tsx imports it.)

const NUS_STUDENT_EMAIL = /^([A-Z0-9._%-]+)@U\.NUS\.EDU$/;   // no `+`: see 02 §domain table

export function normalizeEmail(e?: string | null): string {
  return (e ?? "").trim().toLowerCase();          // .trim() is load-bearing — see I-1
}
export function isNusStudentEmail(e?: string | null): boolean {
  return NUS_STUDENT_EMAIL.test(normalizeEmail(e).toUpperCase());
}
/** Returns "" for anything that is not a valid @u.nus.edu address. */
export function canonicalUserID(e?: string | null): string {
  const m = NUS_STUDENT_EMAIL.exec(normalizeEmail(e).toUpperCase());
  return m ? m[1]! : "";
}
/**
 * Post-canonicalization SANITY CHECK, from the canonical id ALONE. No DB, no
 * allocation. It is a SHAPE test and carries NO provenance: it is sound only
 * when its argument was just produced by canonicalUserID(email). It is never
 * an authorization test and never a provenance test — see I-8d.
 */
export function isCanonicalResidentID(userID?: string | null): boolean {
  return typeof userID === "string" && userID.length > 0 && !userID.includes("@");
}
```

Two rules that fall out and are easy to get wrong:

- **Never gate eligibility on `E_FORMAT` (`/^E\d{7}$/`).** `g.s_samuel@u.nus.edu` is a real account in this database (`scripts/remediation/backups/merge-backup.json`); its canonical id is `G.S_SAMUEL`. `E_FORMAT` remains the validation rule for *grant targets pasted into bulk input*, never for eligibility. This is lockout mode **L-27**, added by this revision.
- `canonicalUserID(e) !== ""` is **exactly equivalent** to `isNusStudentEmail(e)`. The gate and the key cannot disagree because they are the same match.

**Under the stored baseline this predicate now gates the WRITE as well as the check.** An E-format regex here would *permanently withhold* the baseline rather than mis-derive it once — L-27's blast radius has increased, and its fixture list is now a merge gate, not a nicety.

**The write guard is provenance-based, not shape-based.** `isCanonicalResidentID` (renamed in this revision from `isResidentEligible`, which read like an authorization predicate and was called on admin-supplied input) is a sanity check on an already-canonicalized id. The actual guard is that every baseline writer takes the **email** and canonicalizes internally: `const id = canonicalUserID(email); if (!id) return false;`. The only way to reach a baseline write is therefore to have presented an `@u.nus.edu` address. This matters because `targetUserID` on the role-mutation path is admin/jcrc-supplied input that has only passed a format check — a shape test on it would let a pasted bulk list mint stored `resident` rows for principals whose NUS provenance was never established.

Non-NUS accounts already in `User` are handled by an admin-only `AuthAllowlist` collection (`01-data-model.md`). Allowlisting restores **sign-in only**. An allowlisted non-NUS account still has `canonicalUserID === ""`, therefore never receives the baseline, therefore cannot book — under derivation that was a computed fact, under storage it is a stored one, and the user-visible outcome is identical. Say that to the user plainly; it is not obvious. **Open contradiction to resolve in the same edit as `01-data-model.md`:** `02-backend-authz.md` specifies the allowlist as env-var-only with `canonicalUserID === ""`, while `01-data-model.md` and `05-verification.md` specify a `pinnedUserID` with an `EXT:` namespace. `isCanonicalResidentID("EXT:ALICE")` returns **true** (non-empty, no `@`) — so under the pinned variant a shape-only guard would grant the baseline to an allowlisted non-NUS account on its first page load. The provenance-based guard above closes that regardless of which variant ships, but the variant must still be pinned to one answer.

### 2.5 `cca_head` is flat for booking, scoped in storage

Per D-1, **any `cca_head` may book any CCA-gated room**. There is deliberately no per-CCA ownership check this phase.

But every grant also writes a scoped `CcaHead { userID, ccaID }` row, in the same transaction, from day one. Policy (flat) and data (scoped) are separated deliberately: *you can always ignore data you have; you can never recover data you did not write.* `CcaHead` is **not consulted by the booking path** in this phase. The single function that will start consulting it is `canBookWithRoles` in `src/server/api/services/access.ts`; that is the only edit required to make `cca_head` scoped. See `07-cca-future.md`.

Because the two representations must not drift, `cca_head` is **removed from the generic role-mutation path**. `grant` / `revoke` / `set` / bulk-import / deferred-grant all reject it with `USE_CCA_HEAD_ENDPOINT`; it is written only by `admin.grantCcaHead` / `revokeCcaHead` / `transferCcaHead`, which maintain both sides atomically (invariant I-14).

### 2.6 Facility semantics — fail-safe default

Replaces v1's table wholesale. Under D-1 there is no "open to everyone" state.

| `FacilityAccess` state | Meaning |
|---|---|
| **no row** for `facilityID` | `DEFAULT_REQUIRED_ROLES` = `["resident"]` — a normal room |
| `requiredRoles: []` | **also** `["resident"]`. The empty array is not a distinct state |
| `requiredRoles: ["jcrc"]` | jcrc, or admin |
| `requiredRoles: ["cca_head"]` | any cca_head, or admin |

**Why missing-row means `["resident"]` and not deny-all.** Three candidates:

1. *Open-to-all* (today's behaviour, `access.ts:36-39`) — a gated room created before its row is written is silently world-bookable. Silent security failure.
2. *Deny-all* — a normal room created by an admin who forgets the row is unbookable by everyone including its creator. Availability failure, once per new facility, forever.
3. *`["resident"]`* — a normal room created without a row Just Works. A gated room created without a row is over-permissive by exactly one tier, which is the same exposure as (1) but bounded to authenticated NUS residents rather than the world.

(3) is chosen because the overwhelming majority of facilities are normal rooms, and because it is bounded-over-permissive rather than unbounded. **Amended with the stored baseline:** the v2 text claimed (3) has "no lockout path at all" because `resident` could not be absent for a legitimate user. That proof is gone — a user whose baseline write failed or who was never backfilled is now denied on *every* normal room, not just gated ones. The conclusion is unchanged, but the reason is different: (3)'s lockout path is exactly the baseline's own repair path (I-8b, repair-before-read at the session chokepoint), while (2) has one per new facility forever. v1's paragraph arguing for open-by-default is overruled and recorded in the changelog rather than deleted.

The residual exposure of (3) is closed operationally, not semantically: `01-data-model.md` seeds an **explicit row for every facility** (so "configured normal" is distinguishable from "never configured"), facility creation writes a row in the same transaction, and `rbac-doctor.mjs` (§6) reports `UNCONFIGURED` as a red line.

`requiredRoles` is validated against a **separate** enum from grantable roles — `FACILITY_ROLES = ["resident","jcrc","cca_head"]`, with `min(1)`. `admin` is excluded (implicit bypass); `resident` is included (the dashboard must be able to round-trip its own seeded state). Reusing `roleSchema` for both domains is a v1 bug that D-1 exposes.

---

## 3. Permission matrix

Roles stack. Every eligible signed-in account holds `resident` **as stored data**; the other columns are additive on top of it. "Ineligible" is a non-NUS identity or a pre-cutover legacy JWT.

| Capability | admin | jcrc | cca_head | resident | ineligible |
|---|---|---|---|---|---|
| Sign in | yes | yes | yes | yes | **no** (D-7) |
| Book a normal room (`["resident"]`) | yes | yes | yes | **yes** | no |
| Book SCRC Room (`["jcrc"]`) | yes | yes | no | **no** | no |
| Book a CCA room (`["cca_head"]`) | yes | no | yes | **no** | no |
| See all bookings (`seeAll`) | yes | no | no | no | no |
| Delete another user's booking | yes | no | no | no | no |
| Reach `/admin` | yes | yes | no | no | no |
| List / search users | yes | yes | no | no | no |
| Grant / revoke `cca_head` (via CCA endpoints) | yes | yes | no | no | no |
| Transfer CCA headship | yes | yes | no | no | no |
| **Grant `jcrc`** | yes | **no** (D-3) | no | no | no |
| **Revoke `jcrc` from another user** | yes | **no** (D-3) | no | no | no |
| Revoke own `jcrc` (step down) | yes | yes | n/a | n/a | n/a |
| Grant / revoke `admin` | yes | **no** | no | no | no |
| Modify any role of a user holding `admin` | yes | **no** (D-2) | no | no | no |
| Revoke the last remaining `admin` | **no** | no | no | no | no |
| Grant / revoke `resident` † | **no** | no | no | no | no |
| Bulk role import (preview + commit) | yes | yes, `cca_head` only | no | no | no |
| Create / revoke deferred grants | yes | yes, `cca_head` only | no | no | no |
| Write `AuthAllowlist` | yes | **no** | no | no | no |
| Set `FacilityAccess.requiredRoles` | yes | no | no | no | no |
| Flip the enforcement kill switch | yes | no | no | no | no |
| Read role audit log | yes | yes, counts only | no | no | no |
| View / edit own profile | yes | yes | yes | yes | no |
| Edit own roles / email / matric | no | no | no | no | no |

† Unchanged from v2 — all-no in both directions — but the *reason* changed: `resident` is now stored, so removing it is technically expressible in a database write where it previously was not. It is still ungrantable and unrevocable through the ordinary role path (I-8e), and a manual removal is not a sanction because it self-heals. See the note in §3.4.

### 3.1 The escalation guards (carried from v1, tightened)

Every role mutation runs all of these. They are policy-as-data (`ASSIGNABLE_BY`, `REVOCABLE_FROM_OTHERS_BY` as null-prototype maps), not if-statements.

- **G1/G2** — actor is authenticated and holds a role-managing capability.
- **G3 target guard** — a non-admin cannot touch a user who holds `admin`.
- **G4 delta guard** — the *added* set **and** the *removed* set must both lie inside the actor's assignable set, so a set-payload cannot strip a role the actor could not grant.
- **G5 self-revocation** — stepping down from a non-admin role is allowed. Note the D-3 consequence: a jcrc who steps down can be restored only by an admin, not by a peer.
- **G6 no self-assignment** of a role you do not hold.
- **G7 canonical-key guard** — the target userID must be canonical (I-1).
- **Last-admin guard** — transactional, inside `applyRoleChange`. Reaching zero admins is unrecoverable without shell access.
- **Denials are audited** — with `ok: false` and a `denyReason`. See I-15 for the transaction subtlety.

### 3.2 Assignable sets

```ts
export const ASSIGNABLE_BY = Object.assign(Object.create(null), {
  admin: ["admin", "jcrc"] as const,
  jcrc:  [] as const,        // D-3: a jcrc grants NO role through the generic path.
                             // Their cca_head power is a separate capability,
                             // exercised via admin.grantCcaHead (I-14).
  cca_head: [] as const,     // Succession is admin/jcrc-mediated: 07-cca-future.md.
                             // Changing this to ["cca_head"] is the ONLY edit needed
                             // to make handover self-serve, and it REQUIRES an
                             // object-scope guard (caller heads THIS ccaID) that the
                             // role-scoped G1..G7 firewall cannot express.
});
export const REVOCABLE_FROM_OTHERS_BY = Object.assign(Object.create(null), {
  admin: ["admin", "jcrc"] as const,
  jcrc:  [] as const,
});
```

`resident` appears in neither map, in neither direction, at any level. That is not an omission — it is the enforcement of **I-8c and I-8e**. Because the write chokepoint derives its `removed` set from these maps, and `resident` is absent from them, the baseline cannot appear in a removal payload at all; it is not filtered out, it is unrepresentable.

### 3.3 Capabilities are computed server-side, once

D-2 forbids an `isAdmin` fork. `whoAmI()` returns a single server-computed object; the dashboard renders from it and never re-derives:

```ts
type Capabilities = {
  canReachAdmin: boolean;
  assignableRoles: Role[];          // from ASSIGNABLE_BY — `admin` is ABSENT for jcrc,
                                    // not rendered-disabled: do not leak the ladder
  canManageCcaHeads: boolean;
  canBulkImport: boolean;
  canSetFacilityAccess: boolean;
  canWriteAllowlist: boolean;
  canFlipEnforcement: boolean;
  canReadAuditDetail: boolean;      // false for jcrc: counts only
  canModifyAdmins: boolean;
};
```

### 3.4 What is deliberately NOT in this revision

- **`suspended` / any affirmative sanction.** It appears in none of D-1…D-8. Adding it half-specified would give a suspended admin full booking and full `/admin` (bypass ordering), and a jcrc an un-suspend primitive via an unrelated role toggle. Mode "revoke resident as denial-of-service" is still closed — by I-8c/I-8e rather than by derivation — so the sanction buys nothing here. If it is wanted later it needs its own mutation, its own audit action, its own matrix row, admin-only, evaluated *before* the admin bypass, and it must deny `requireRoles` too.

  **Forward note added by the stored-baseline revision, recorded so it is not invented wrongly later.** Storing `resident` makes "bar this person from booking" look technically reachable in a way derivation did not. It is not. A removal of `resident` — through the role UI (impossible), or by a direct database edit (possible) — is **repaired at the target's next page load by I-8b**, so a sanction built that way silently lapses within one request, which is the worst possible failure mode for a disciplinary control. Special-casing self-heal to respect a "deliberately revoked" marker means storing a second fact anyway, at which point removing the first is pointless. If a booking ban is ever wanted it is a **new `BookingBan { userID @unique, reason, bannedBy, at, expiresAt? }` collection** (new collection, per the standing `$jsonSchema` invariant), checked in `evaluateBooking` *before* the admin bypass, with its own `admin.setBookingBan` / `clearBookingBan` mutations, its own audit actions and a confirmation dialog. It composes with everything here and touches `UserRole` not at all. **Do not build it.** Note also the limit of the self-heal argument: it defeats removal performed through the application's own write paths and through a one-off manual edit, and it makes accidental removal self-correcting. It is **not** a control against an actor with sustained database write access, who can equally write `SystemFlag`, delete the `User` row, or set an unsatisfiable `requiredRoles`.
- **Per-CCA scoping of `cca_head` for booking** (D-1, explicit).
- **Self-serve CCA handover** (`07-cca-future.md` §upgrade path).

---

## 4. Invariants

Violating any of these produces a silent security failure or a silent lockout. Each is restated at its implementation site.

### Carried from v1

**I-1 — Canonical key.** All role data is keyed on the canonical userID from `canonicalUserID(email)` (§2.4). **Never** on `User.userID` — ~515 rows hold an A-format matric there (`prisma/schema.prisma:352`). A mis-keyed grant creates a row no session will ever match: it appears to succeed and does nothing. **Amended in v2:** the transform is now anchored, trims, and returns `""` on non-match. `src/server/auth.ts:135-137` currently uses an unanchored `.replace()` with no `.trim()`; adopting the anchored form is **mandatory**, not "recommended", and is gated on a re-key audit (I-16).

**I-2 — No required non-list scalars on populated collections.** `UserRole` and `FacilityAccess` already contain documents. Prisma 6's Mongo connector throws when deserializing a document missing a required non-list scalar; `@default` is write-time only and never backfills on read. The role read sits in the session callback, so such a field hard-breaks login. Every field added to these models is nullable or a scalar list. **Extended in v2 by I-9** — the inverse case (writing a document that *omits* an already-required scalar) is the same fault and bit three separate tracks.

**I-3 — Backfill before push, push before code.** Data migration runs through `$runCommandRaw` before `prisma db push`, which runs before any code deploy. **Refined in v2:** this holds for backfills that *modify existing* documents. Any script that **creates new** documents runs **after** the push that made the legacy scalars optional (I-9). Order within Phase 2 is: array backfill → push → document-creating scripts.

**I-4 — Roles are never in the JWT.** `maxAge: 30d` (`src/server/auth.ts:119`). A role in the token means a revoked admin keeps admin for a month. Roles resolve live in the `session` callback, mirroring the existing `userMatric` lookup.

**I-5 — `session.user.roles` is render-only.** Every authoritative check re-reads from the database. This also closes a TOCTOU where an admin is demoted mid-request. Same for `session.user.eligible`.

**I-6 — No positional role shim.** `getUserRole` returning `roles[0]` is deleted, not deprecated: `roles[0]` is insertion order, so `["jcrc","admin"]` silently loses admin. Both call sites — `src/server/api/routers/facilitiesBooking.ts:130-131` and `:383-384` — convert in the same commit.

**I-7 — Client gating is cosmetic.** Every disabled control, hidden option and redirect has an independent server check. Escalation testing is done against the server, never by clicking. **Corollary added in v2:** a client gate must never be *stricter* than the server either — a client-side domain check that blocks submission makes the server-side `AuthAllowlist` unreachable.

### New in v2

**I-8 — The baseline is STORED, universal, and self-healing.** *(Repeals v2's "the baseline is derived, never granted" in full, by explicit user instruction — see changelog row 21.)* `resident` is a real row value in `UserRole.roles`, held by **every** sign-in-eligible identity including admins, jcrc and cca_head. Roles stack; `resident` is the floor, never an alternative. Authorization reads the stored value. Three mechanisms — and only these three — keep the stored value true: **grant at creation (I-8a)**, **self-heal at session read (I-8b)**, **sticky at every write (I-8c)**. Removing any one re-opens a lockout class the other two do not cover.

**I-8a — Grant completeness.** Every code path that creates a `User` document must ensure the baseline in the same request. The enumerated set is `src/app/api/register/route.ts`, the NextAuth `events.createUser` hook (**not** `callbacks.signIn`, which runs before the adapter writes the row and whose return value is the D-7 gate; **not** `events.linkAccount`, which fires for existing users), and the account merge/dedupe scripts. `scripts/remediation/seed-rbac.mjs` is deleted rather than fixed. **Adding a new account-creation path without a baseline grant is a silent lockout of every account it creates.** Merge-blocking grep gate: `grep -rnE "user\.create|user\.createMany|user\.upsert|createUser|insert:\s*\"User\"" src/ scripts/` — every hit is either a grant point or carries a comment naming why it is not. Note for the `createUser` hook specifically: `PrismaAdapter` writes only `email`/`name`/`image`/`emailVerified`, so `user.userID` is `null` there and the key **must** come from the email (I-1); and contrary to a natural reading of NextAuth v4, a rejection from `events.createUser` **does** surface as an `/api/auth/error?error=Callback` on the user's first sign-in, so the hook body must be individually try/caught.

**I-8b — Self-heal.** A missing baseline repairs itself at the next session read, before any role is consumed. This rests on a structural property that must itself be gated, not assumed: **every authoritative role check is preceded, in the same request, by a run of `callbacks.session`** (`src/server/api/trpc.ts:30` → `auth()` → `getServerSession`, JWT strategy, no session cache). Merge-blocking grep gate alongside I-8a's: `grep -rn "getUserRoles\|isAdmin(" src/app/api/ src/server/` — every call site must be reachable only from a context that ran `auth()`, or must call `ensureBaseline` itself. The repair is idempotent, race-safe under concurrent session callbacks, awaited only on the cold path, and **can never throw into the session** — that clause covers *every* promise originated in the callback, not just `ensureBaseline`; an unhandled rejection there is a lambda-level fault on the hottest route in the app, i.e. a mass availability event. Steady state it issues **zero** extra reads and zero writes. Two scope limits, stated so they are not discovered later: (a) a repair that keeps failing must not be retried per-request — `ensureBaseline` carries a per-lambda negative cache and a global circuit breaker (same 15s `SystemFlag` cache pattern as I-11), so a `UserRole`-scoped write outage degrades to one attempt per lambda per window instead of a self-amplifying latency event across 515 simultaneously-cold users; (b) **the repair-before-read guarantee holds only for requests that traverse the Next.js session callback.** Any other consumer of `UserRole` — the droplet Python backends, bots, cron, scripts — must either call the same idempotent top-up or treat a missing baseline as *unknown*, never as *denied*.

**I-8c — Sticky by construction, not by convention.** No role write may produce a role set that omits `resident` for an eligible identity. Enforced at the single write chokepoint by writing a delta (`$pull` of `removed`, `$addToSet` of `added`) instead of a set-payload, where `removed ⊆ before ∩ GRANTABLE_ROLES` and `resident ∉ GRANTABLE_ROLES` — so `resident` is not filtered out of the removal set, it is **incapable of appearing in it**. Three corrections that are part of the invariant, not implementation detail: (1) the delta must be **one single-document write guarded by a compare-and-set on the observed `before` set**, returning `CONFLICT_ROLES_CHANGED` on zero matched documents — a two-entry bulk `updates: []` array is not atomic across its entries, and an unguarded delta lets a concurrent grant's `$addToSet` silently undo a revoke while the audit row claims otherwise; (2) `$set` and `$setOnInsert` may **never** name the same path (`ConflictingUpdateOperators`), so the chokepoint carries `$set: { role: legacyMirror(after) }` and no `$setOnInsert: { role: "" }` — the I-9 sentinel belongs only where nothing else writes `role`, i.e. `ensureBaseline`; (3) Prisma's Mongo connector does **not** run raw commands inside an interactive transaction session, so a raw chokepoint write is *not* atomic with the last-admin `count()` that guards it — the guard and the write must be one atomic operation, by compare-and-set or by staying inside Prisma's typed API, and the doc at the implementation site must say which. The UI-level `STICKY` list in `03-admin-dashboard.md` §10.4 is demoted to a copy-consistency aid; it is no longer a mechanism.

**I-8d — Never for the ineligible.** `resident` is written only behind the **email**, canonicalized inside the writer (`const id = canonicalUserID(email); if (!id) return false;`), never behind a shape test on a caller-supplied id. `isCanonicalResidentID` (§2.4) is a post-canonicalization sanity check and carries no provenance; it must never be the guard on the role-mutation path, where the target id is admin/jcrc-supplied input. Every writer — register route, `createUser` event, self-heal, backfill, merge script — obeys this. A `UserRole` row keyed on an id containing `@`, or on `""`, holding `resident`, is a red doctor line and a security failure, not a cosmetic one. Corollary for the read path: the session callback must **early-return zero roles when the canonical id is `""`**, skipping the `UserRole` lookup and the repair entirely — otherwise every non-canonicalizable principal inherits the roles of any `""`-keyed row that exists, including `admin`, with no grant path and therefore no escalation guard firing.

**I-8e — Ungrantable, and un-revocable through the ordinary path.** `resident` stays out of `GRANTABLE_ROLES`, `roleSchema`, `ASSIGNABLE_BY` and `REVOCABLE_FROM_OTHERS_BY`, in both directions, at every level. It is unrepresentable in any grant, revoke, set, bulk, undo or deferred payload. **Corollary that must be stated wherever anyone might try it:** a manual database revocation of `resident` is *not* a sanction — I-8b repairs it at the target's next page load. A booking ban, if ever wanted, is a separate affirmative flag (§3.4), never the absence of the baseline.

**I-8f — A raw write's reply must be inspected, not just its exception.** Prisma's `$runCommandRaw` does **not** throw on per-write failures: the MongoDB `update` command resolves with `{ ok: 1, n: 0, writeErrors: [...] }`, and Prisma passes that through as data (it rejects only on `ok: 0` or a driver-level fault). Every raw write in this design — `ensureBaseline`, the role chokepoint, the backfill's per-batch accounting — must read `res.writeErrors` and `res.nModified` / `res.upserted`, treat a non-empty `writeErrors` as failure, use `writeErrors[0].code === 11000` as the retry trigger (a concurrent insert may have been a bulk grant that did not include the baseline, so E11000 is retried once, never swallowed as success), and throw *before* `writeAudit` so a failed write is never recorded as `ok: true`. Keep the try/catch for connection-level faults, but the reply check is the primary path. **This invariant is what makes I-8b's residual detectable at all**: without it a failed repair returns success, the log line never fires, and the one honest gap in §5 becomes silent.

**I-9 — Legacy scalars become optional before any new document is written.** `prisma/schema.prisma:247` `role String` → `String?` and `:255` `requiredRole String` → `String?`, in the **same `db push`** that adds `roles String[]` / `requiredRoles String[]`. **Made doubly non-negotiable by the stored baseline:** the resident backfill is now authoritative *and* `ensureBaseline` creates `UserRole` documents on the hot path indefinitely, so the volume of new documents is no longer bounded by a migration window. Without this, the resident backfill and the per-facility seed create documents lacking a required scalar and the *currently deployed* client throws on every read of `getUserRole` (`access.ts:19`) and `getFacilityRequiredRole` — a total booking outage several steps *before* the kill switch exists. Belt and braces: every upsert that does not otherwise write the scalar carries `$setOnInsert: { role: "" }` / `{ requiredRole: "" }`. **`$set` and `$setOnInsert` may never name the same path** — MongoDB rejects that with `ConflictingUpdateOperators` at parse time, so a write already carrying `$set: { role: ... }` must not also carry the sentinel (I-8c). The sentinel is the **empty string, not `null` and not `"user"`**: the still-deployed old client declares the field required and throws on absence *and* on `null`, whereas `""` is defined for it and is falsy — so the live `access.ts:36` `if (!required) return true` preserves today's open-by-default behaviour and `access.ts:19` `row?.role ?? DEFAULT_ROLE` degrades safely (see `01-data-model.md` §0.1).

**I-10 — Fail-safe facility default.** No `FacilityAccess` row, or an empty `requiredRoles`, both mean `["resident"]`. **Amended with the stored baseline:** this default's lockout path is no longer empty — a user missing the stored baseline is denied on every normal room, not only gated ones. The choice stands (§2.6), but it is now closed by I-8b's repair-before-read rather than by derivation. There is no early `return true` and no `if (!row) return []` anywhere on the booking path — those were the two default-open paths. Facility creation writes a `FacilityAccess` row in the same transaction.

**I-11 — Enforcement is data-flippable, and `off` means LEGACY, not ALLOW.** The kill switch is a `SystemFlag` row read behind a 15s per-lambda cache, not an env var — on Vercel an env change requires a redeploy, so an env-only switch is a false safety net on the day it matters. Three modes: `off` = **pre-D-1 semantics** (empty/missing `requiredRoles` allows, non-empty still enforced with admin bypass) — *not* blanket-allow, which would un-gate SCRC for the whole shadow window; `permissive` = evaluate, audit the would-be denial, allow; `enforce` = deny. A flag read error degrades to `off`, i.e. to today's behaviour. An env var supplies the deployment-level floor.

**I-12 — One eligibility predicate.** The D-7 sign-in gate, every baseline **writer** (register route, `events.createUser`, `ensureBaseline`, the backfill, the merge scripts), `isCanonicalResidentID`, the bulk resolver's domain check and every backfill share `src/lib/identity.ts`. Scripts under `scripts/remediation/` cannot import TypeScript, so they use `scripts/remediation/lib/identity.mjs`, a literal mirror with a parity test over a fixture list that must include `g.s_samuel@u.nus.edu`, `E1633673@U.NUS.EDU`, whitespace-padded, `bob@u.nus.edu.evil.com`, `bob@evil.com@u.nus.edu`, `""` and `null`.

**I-13 — Role writes are atomic and additive.** Every `UserRole.roles` write is `$addToSet` / `$pull` (via `$runCommandRaw` where Prisma cannot express it), never a blind set-payload derived from client state, and never Prisma `push` (which does not dedupe). A read-modify-write that reads `null` and writes `[]` is how a role silently disappears. **This now has two named violators to fix,** both harmless under derivation and lockout-bearing under a stored baseline: `applyRoleChange` in `02-backend-authz.md` writes `roles: after` as a blind set-payload (see I-8c), and `redeemPendingGrants` writes `roles: after` computed from a stale `before` read, racing the session callback's `$addToSet` — convert it to `$addToSet: { roles: { $each: granted } }`, since it never removes anything. Note honestly what the delta form does *not* buy: `added`/`removed` are still computed from an earlier `before` read, so the read-modify-write is split across statements rather than eliminated — which is why I-8c requires the compare-and-set on the pre-image. Merge gate: no Prisma `data:` object under `src/server/api/services/` or `src/server/api/routers/` contains a `roles` key. Assert this with an AST check, not a line-based grep — a multi-line `$addToSet: { roles: ... }` produces a false positive, and per I-16 a gate that cannot reach zero gets muted.

**I-14 — `cca_head` never travels the generic role path.** It is rejected by `grant` / `revoke` / `set` / bulk / deferred-grant input validation, and written only by the CCA endpoints, which maintain the `UserRole` string and the `CcaHead` row in one transaction. Invariant **CH-1** — *a user holds the `cca_head` string **iff** they have ≥1 `CcaHead` row* — is checked by a two-direction drift query in `05-verification.md`, both directions must return 0.

**I-15 — Denial audits are written outside the transaction.** `forbid()` inside a `$transaction` rolls its own audit row back, so the denial leaves no trace — defeating abuse detection on exactly the surface most likely to be probed. Catch at the procedure boundary and write the audit on `ctx.db`, not `tx`, before rethrowing. Dry-run previews are the inverse case: they must evaluate the same guards but write **no** audit at all (a 500-row preview would otherwise emit 500 denial rows for a hypothetical).

**I-16 — Every gate names the offenders.** Detection queries, migration verifiers and the doctor report the offending userIDs / facilityIDs, not just a count. The stored baseline adds one: **`eligible NUS users missing stored resident`** — a red line, naming the ids, scoped to `User.email` matching the NUS regex only. A count you cannot act on gets muted; the checks that gate the irreversible steps must be actionable at 2am. Corollary: a gate that can never return zero (e.g. counting non-NUS accounts as "missing resident") will be commented out by the operator, deleting the detector it replaced — every gate must be scoped to a population it can actually clear.

### Standing invariant (unchanged, from #23)

Many collections carry DB-level `$jsonSchema` validators: `User`, `Facilities`, `CCA`, `UserCCA`, `Posts`. **New persisted data goes in NEW collections, never as new fields on those models.** New collections carry no validator, so required scalars are safe *there*. Note the corollary discovered in v2: a `@@unique` **index** constrains uniqueness across documents, not document shape — it adds no field and so does not violate this. `@@unique([ccaID, userID])` on `UserCCA` is therefore available (`07-cca-future.md` C-3); `isHead` on `UserCCA` is not.

---

## 5. Lockout prevention

The single highest risk in this revision is that D-1 inverts booking to default-deny and ~515 users end up unable to book. 27 failure modes were enumerated (26 from the impact report, plus **L-27**, E-format eligibility gating — §2.4). **This table was re-derived from scratch when `resident` became stored, not inherited.** The ~15 modes v2 attributed to derivation (I-8) do not close for free any more; they are re-closed by mechanism, with the honest residuals named. New tally: **17 closed, 5 mitigated-and-detected**.

| Class | Modes | Closure |
|---|---|---|
| Write on the critical path — the class derivation used to remove | mis-keyed backfill, partial backfill, interrupted backfill, upsert race, new-signup gap, merged accounts, JWT-only trigger, no `UserRole` row at all, role-less document from an older script, restored-from-backup / manual deletion | **Structural, by mechanism** (I-8a + I-8b). Creation-path grant covers new accounts; **self-heal at the session chokepoint** covers everyone the grant or the backfill missed, and repairs *before* the value is consumed. The trigger is `callbacks.session` — which runs on every request — not `events.signIn`, which is why the JWT-only-trigger mode does not re-open. Mis-keying is inert rather than harmful because the backfill and the runtime derive the key from the same `canonicalUserID` (I-12), and the repair writes the correct key. The upsert race closes only because E11000 is **retried, not swallowed**, and only because the reply is inspected (I-8f). |
| Silent write failure — the one genuinely re-opened mode | the baseline write throws, is dropped, or fails scoped to `UserRole` | **MITIGATED + DETECTED, not closed.** Retried once on E11000; retried again at book time by repair-on-deny in `evaluateBooking`; and a general write outage blocks `createBooking` anyway, so it is not a *differential* lockout. A **partial** failure — writes succeeding elsewhere but failing on `UserRole` — is a real lockout. Detected by the `{"evt":"baseline_repair_failed"}` structured log, the `admin.systemHealth` panel, and the daily doctor red line. This is the entire gap between derivation and storage, and it exists only because I-8f makes it visible. |
| Read-boundary stripping | `normalizeRoles` drops it, missing from `roleSchema`, set-payload strips it, bulk strips it, undo strips it, dialog omits it | **Structural, by construction** (I-8c). `normalizeStoredRoles` now *keeps* `resident`. Every stripping mode routes through one guarded chokepoint whose `removed` set is grantable-only, and `resident ∉ GRANTABLE_ROLES` — so it cannot enter a removal payload. Absence from `roleSchema` now protects the value instead of erasing it. |
| Revocation as denial-of-service | jcrc revokes a peer's `resident` | **Structural** (§3.2, I-8e). Unrepresentable in any payload, in either map, in either direction. A direct database revocation additionally self-heals — but see §3.4: that is not a control against an actor with database access. |
| Ordering | default-deny deploys before the data exists | **Structural + process** (I-11). Code ships in `off`; enforcement is a later, revertible, data-only flip. |
| Required-scalar faults | role-less / requiredRole-less documents break the deployed client | **MITIGATED + DETECTED** (I-9 + a pre-deploy gate). Materially worse under a stored baseline: the backfill is authoritative *and* `ensureBaseline` writes new documents on the hot path forever, so every one of them must carry the `""` sentinel. Detected by the doctor line `UserRole rows missing the legacy scalar`, which must be 0 before code ships. |
| Key drift | anchoring re-keys users, whitespace, `+`-addressing, non-E-format localparts (L-27) | **MITIGATED + DETECTED** (I-12, I-16), unchanged from v2 — derivation never closed this either. Deploy is blocked on a re-key audit returning zero orphans across `UserMatric`, `UserRole`, `Bookings.userID` and `UserCCA.userID` — not just the role rows. If a user *is* re-keyed, I-8b gives them a baseline under the new key at first login, but their bookings and matric still orphan; the audit exists to prevent that and this revision does not change it. |
| Facility config | seed resolves by name; new facility has no row | **Structural + detection** (I-10). Seed is keyed on `facilityID`; `UNCONFIGURED` is a red doctor line. |
| Triage | `matricProcedure` fires first; admin bypass masks everything; bare FORBIDDEN | **Structural + process.** Denial reasons are disjoint codes (`MATRIC_REQUIRED` / `NOT_RESIDENT` / `ROLE_REQUIRED`) surfaced to the UI; the booking picker consumes `getFacilitiesForBooking` with `canBook` + `requiredRoles` (no longer optional); **testing from `E1633673` is forbidden** — use a second real NUS account plus `admin.explainAccess`. |
| Invisibility | no detection query exists anywhere | **MITIGATED + DETECTED** (§6) — a detector is by nature detection, never closure; listed honestly. The doctor, `admin.systemHealth` and the standing daily query are all **promoted from advisory to red lines** by the stored baseline: a non-empty "missing resident" result was a materialization gap, it is now a live lockout and it blocks the `enforce` flip. |
| Eligibility gated on E-format (L-27) | non-E-format `@u.nus.edu` localparts (`g.s_samuel@u.nus.edu` → `G.S_SAMUEL`) excluded | **Structural** (§2.4, I-12) — but the blast radius has grown: the same predicate now gates the **write**, so an E-format regex would permanently withhold the baseline rather than mis-derive it once. Narrower than it looks: G7's `isEFormatUserID` check on the *mutation* path is a separate pre-existing decision and still excludes `G.S_SAMUEL` as a role-mutation target. That is not a booking lockout — `ensureBaseline` covers them — but it is not closed by this row either. |

Two things that were optional in v1 are now mandatory because of this: wiring `getFacilitiesForBooking` into `BookingModal.tsx` / `Calender_v2.tsx` (a locked-out user must not be able to select a room they cannot book), and adopting the anchored `canonicalUserID`. Note `getAllFacilities` (`facilitiesBooking.ts:28-32`) is **retained unchanged** — `Calendar.tsx:24` and `PastBookings.tsx:66` are display-only consumers. Grep gate before merge: no `getAllFacilities` call site decides whether a booking control is enabled.

---

## 6. Detection: `rbac-doctor.mjs`

Read-only, safe to run any time, exit 1 on any red line, also surfaced on `/admin` (aggregate counts for jcrc; per-user identifier lists **admin only** — the raw output discloses account-integrity data that D-2/D-3 keep above jcrc).

```
users(total) / eligible / INELIGIBLE (cannot sign in)     <- D-7 migration list
canonical id collisions / empty / non-E-format            <- merged accts; blank email; informational only
UserRole rows keyed on a non-canonical id                 <- I-1
eligible NUS users missing stored resident                <- I-8, RED, blocks the enforce flip
UserRole / FacilityAccess rows missing the legacy scalar   <- I-9, must be 0 before code ships
User rows missing passwordHash                            <- blocks any session-callback User lookup
facilities / with a row / UNCONFIGURED / requiredRoles==[] <- I-10
requiredRoles containing "admin" or "resident"-in-mirror   <- 06-legacy-cutover.md
CH-1 drift: string-without-scope / scope-without-string    <- I-14, both must be 0
enforcement mode / shadow denials, last 24h                <- the go/no-go signal
```

The three lines that gate the cutover are **`UNCONFIGURED`**, **`eligible NUS users missing stored resident`** and **`shadow denials, last 24h`**.

---

## 7. Phase sequencing

Each phase is independently deployable and verifiable. **Nothing between phase 0 and phase 7 changes what any user can do**, because the enforcement flag is `off` throughout.

| # | Doc | Content | Reversible? |
|---|---|---|---|
| 0 | 04 step 1 | `passwordHash` leak fix in `updateUserData` (one-line `select`) | trivially |
| 1 | 01 §0–5 | **Inventory only, no writes.** Backups + restore rehearsal; verify `E1633673`; canonical re-key audit across all four keyed collections; non-NUS `User` inventory; `passwordHash`-missing count; `+`/whitespace email counts; facility enumeration + hand-written `facility-roles.json`; `UserCCA` key-format census (07 prerequisite) | n/a |
| 2 | 01 | **Data + schema.** Array backfill (existing docs) → `db push` **incl. legacy scalars → optional (I-9)** + `AuthAllowlist`, `RoleAuditLog`, `SystemFlag`, `CcaHead`, `BulkRoleImport`, `PendingRoleGrant` → seed admin + per-facility rows keyed on `facilityID` → **authoritative resident backfill + VERIFY pass (set-difference against the eligible population, names every missing id, exit 1 on any)** → delete `seed-rbac.mjs` → set flag `off` → doctor green | yes, from backup |
| 3 | 02 §identity | **D-7 sign-in restriction.** `src/lib/identity.ts`, `signIn` callback (returns `false`; OAuth denial uses a **relative** redirect — `env.NEXTAUTH_URL` is scheme-less on Vercel), `redirect` callback passes through same-origin, credentials `authorize` domain check, register + reset-password routes centralised, ineligible-session terminal state with a working sign-out | yes, revert deploy |
| 4 | 02 | **RBAC core, enforcement `off`.** `roles.ts` + `normalizeStoredRoles`, `baseline.ts` + `ensureBaseline`, the `events.createUser` grant hook and the register-route grant (I-8a), the session-callback self-heal (I-8b), the sticky role-write chokepoint (I-8c), `access.ts` rewrite incl. repair-on-deny, session roles + type augmentation (`roles`, `isAdmin`, `eligible`), tRPC `adminProcedure` / `roleManagerProcedure`, admin router, both `getUserRole` call sites (I-6), `getFacilitiesForBooking` wired into the booking picker | yes, revert deploy |
| 5 | 03 | `/admin`: capability-driven tabs, users table, bulk import wizard, deferred grants, audit log, facility access, health panel | yes, revert deploy |
| 6 | 04 | Profile view/edit, validation, read-only role badges | yes, revert deploy |
| 7 | 05 | **Shadow.** Flag → `permissive`. ≥72h spanning a weekday and a weekend. Zero `NOT_RESIDENT` denials required to proceed; doctor's `missing stored resident` line must be 0 | yes, flip the flag |
| 8 | 05 | **Enforce.** Flag → `enforce`. Prerequisite: the backfill re-run prints `MISSING 0` **and** `modified 0, upserted 0`. Revert is one command, live in 15s | yes, flip the flag |
| 9 | 07 | CCA head endpoints (`grantCcaHead` / `revokeCcaHead` / `transferCcaHead`), `/admin` CCAs tab, `UserCCA` dedupe + `@@unique` | yes, revert deploy |
| 10 | 06 | **Legacy drop.** ≥14-day dual-write window, containment gate, backup, remove reads → remove writes → `$unset` | **no** |

Ordering constraints that are not negotiable:

1. Phase 1 completes before phase 2 writes anything. If the non-NUS list contains your own admin account, phase 3 bricks the deployment.
2. Phase 3 (D-7) precedes phase 4 in effect: otherwise any Google account can mint a canonical userID and self-derive `resident`. Shipping them in one deploy is acceptable; shipping 4 first is not.
3. Within phase 2: array backfill → push → document-creating scripts (I-3 as refined, I-9).
4. Phase 10's `$unset` runs **after** the dual-write code is out of production, never before. v1's step 12 has no deploy step at all; that omission is the permanently-mixed-state bug.
5. Phase 7's shadow window and phase 10's dual-write window are separate clocks. Do not bundle.
6. The resident backfill is **re-run immediately before the enforce flip**, to catch anyone created in the window. It must report `MISSING 0` and — critically — `modified 0, upserted 0`, accumulated from the raw command replies (I-8f), because the set-difference alone reads 0 either way once the write lands and therefore cannot detect a broken creation-path grant. If it writes anything, G-A or G-B is broken; do not flip.

---

## 8. Changelog — what changed from v1, and why

| # | v1 said | v2 says | Driver |
|---|---|---|---|
| 1 | Missing `FacilityAccess` row = open to everyone; empty array = open; the inverse "is a footgun" | No row / empty = `["resident"]`. No open state exists | D-1 |
| 2 | Roles are `admin`, `jcrc`, `cca_head`; `"user"` is implicit and never stored | Four roles; `"user"` deleted; `resident` is the floor | D-1 |
| 3 | — | `resident` is **stored** and auto-assigned: written at account creation on every creation path, backfilled authoritatively to all current members, held by every account including admins; self-healed at the session chokepoint; still not grantable and not revocable through the role path | D-1 + **user overrule** (I-8, see row 21) |
| 4 | Matrix: "book an ungated facility — yes for all" | That row is gone. Every facility is gated; the floor is `resident` | D-1 |
| 5 | jcrc may grant `jcrc` (D-3 as then-drafted) | **Only admins grant or revoke `jcrc`.** `ASSIGNABLE_BY.jcrc` is `[]` | D-3 (reversed) |
| 6 | jcrc grants `cca_head` through the generic path | `cca_head` is rejected by the generic path; a separate capability + dedicated endpoints keep `UserRole` and `CcaHead` consistent | D-3 + CCA forward-design (I-14) |
| 7 | D-7 listed under "follow-ups explicitly out of scope" | D-7 is **in scope and a prerequisite**; it is phase 3 | D-7 |
| 8 | `canonicalUserID` adoption "optional (recommended)" | Mandatory, anchored, trimmed, returns `""`, in `src/lib/identity.ts`, gated on a four-collection re-key audit | D-7 (I-1, I-12) |
| 9 | Drop the legacy scalars is "optional" | **Scheduled**, with a dual-write window, containment gate, backup, restore script and go/no-go checklist — `06-legacy-cutover.md` | D-6 (reversed) |
| 10 | Legacy scalars stay required | Optional in the same push that adds the arrays | D-6 + I-2 inverse (I-9) |
| 11 | Bulk: E-format ids only, one role, no pending state | Full resolver (email / NUSNET / matric / name), ambiguity + confirmation buckets, chunked commit, per-row results, undo, deferred grants with expiry and redemption-time re-authorization | D-8 |
| 12 | One admin dashboard with `isAdmin` forks in ~7 places | One server-computed capability set; no client role branching | D-2 |
| 13 | `CcaHead` "defined now, populated later" | Populated from the first grant; not consulted by booking; `canBookWithRoles` named as the single future scope-check site | New CCA scope |
| 14 | Succession unmentioned | Admin/jcrc-executed `transferCcaHead` ships; self-serve deferred with a named four-step upgrade path | New CCA scope |
| 15 | — | Kill switch (`SystemFlag`, three modes, `off` = legacy semantics), shadow rollout, `rbac-doctor.mjs`, structured `BookDecision` reason codes | Lockout analysis (I-11, I-16) |
| 16 | Wiring `getFacilitiesForBooking` into the picker was optional | Mandatory | D-1 |
| 17 | Eligibility conceptually tied to E-format | E-format is never an eligibility test; non-E-format `@u.nus.edu` localparts are real | L-27 |
| 18 | Roles `String[]` on `UserRole`, `userID @unique`, array-not-junction rationale | **Unchanged.** Still correct | — |
| 19 | I-1 … I-7 | **Carried forward**, I-1/I-3/I-7 amended as noted; I-8 … I-16 added (I-8 subsequently repealed and replaced — row 21) | — |
| 20 | "Decisions D-1 through D-5 answered (D-6 through D-8 may lag)" | All eight answered and binding | — |
| 21 | v2's **I-8: `resident` is derived, never granted.** The `UserRole` write was explicitly advisory and authorization was forbidden from depending on it | **I-8 is repealed by explicit user instruction** — *"resident should be automatically assigned, so everyone technically has the resident role even admin and others so just auto assign the role during creation and on the current members too."* `resident` is now genuinely stored data, auto-granted at creation, backfilled authoritatively to ~515 members, held by every role-holder. Replaced by I-8a (grant completeness), I-8b (self-heal at the session chokepoint), I-8c (sticky by construction), I-8d (never for the ineligible, provenance-based), I-8e (ungrantable and un-revocable), I-8f (inspect raw-write replies). §5's closure table was **re-derived, not inherited**: the ~15 modes v2 attributed to derivation are re-closed by mechanism, and the residuals — a `UserRole`-scoped partial write failure, key drift, required-scalar volume, and detection-is-not-closure — are named as MITIGATED + DETECTED rather than papered over. `isResidentEligible` is renamed `isCanonicalResidentID` because it is a shape test with no provenance and was being read as an authorization predicate. §2.6/I-10's "no lockout path at all" proof is retracted; the choice stands on other grounds | **User overrule** |

Considered and **rejected**: a `suspended` sanction (§3.4); **exposing revocation of the now-stored `resident` as a "bar this person from booking" sanction** — it would not work (I-8b repairs it within one request), it would re-open the entire mass-strip class the moment `resident` became expressible in a payload, and the policy is under-specified; a booking ban is a separate affirmative flag (§3.4); composite scoped entries inside `UserRole.roles` (breaks I-2, contaminates the guard maps, `roles` is render-only anyway — `07-cca-future.md` C-1); an env-var-only kill switch (needs a redeploy on Vercel); blanket grandfathering of every email already in `User` (the collection contains `test@` and `aaaaaa@`, so "already present" is not a trust signal).

---

## 9. Done when

- [ ] Every reader of this document can state, without looking: `resident` is stored, auto-assigned to everyone including admins, self-heals at login, and cannot be granted or revoked through the role UI; missing `FacilityAccess` row means `["resident"]`; only admins touch `jcrc`; `cca_head` never travels the generic role path.
- [ ] Phase 1's inventory has run and its output is recorded: non-NUS `User` list triaged with the user, `passwordHash`-missing count, re-key orphan count **zero** across `UserMatric`, `UserRole`, `Bookings.userID`, `UserCCA.userID`, `UserCCA` key format known, `facility-roles.json` hand-written and reviewed.
- [ ] The doctor (§6) is green except `enforcement mode`, before any code ships.
- [ ] `grep -rn "normalizeRoles" src/` returns call sites only inside `roles.ts` — `normalizeStoredRoles` has replaced it everywhere, and it **keeps** `resident`.
- [ ] I-8a creation-path gate: `grep -rnE "user\.create|user\.createMany|user\.upsert|createUser|insert:\s*\"User\"" src/ scripts/` — every hit is a baseline grant point or carries a comment naming why it is not.
- [ ] I-8b chokepoint gate: `grep -rn "getUserRoles\|isAdmin(" src/app/api/ src/server/` — every call site is reachable only from a context that ran `auth()`.
- [ ] I-8c no-set-payload gate: no Prisma `data:` object in the role services contains a `roles` key (AST check, not a line-based grep).
- [ ] `grep -rn "getUserRole\b" src/` returns nothing (I-6); both `facilitiesBooking.ts` call sites converted in one commit.
- [ ] No code path outside `src/server/api/services/ccaHead.ts` writes the string `"cca_head"`; CH-1 drift queries both return 0.
- [ ] `resident` appears in no `z.enum`, no `ASSIGNABLE_BY` entry, no mutation input schema anywhere in `src/`.
- [ ] The parity test between `src/lib/identity.ts` and `scripts/remediation/lib/identity.mjs` passes over the full fixture list including `g.s_samuel@u.nus.edu`.
- [ ] Each phase's own "Done when" checklist in docs 01–07 passes.
- [ ] Doc 05's persona verification passes, executed against the server and **not** from `E1633673`.
- [ ] Shadow window: ≥72h at `permissive` with zero `NOT_RESIDENT` denials before flipping to `enforce`.
- [ ] Phase 10's go/no-go checklist in `06-legacy-cutover.md` is fully checked by a named human before the `$unset`.
