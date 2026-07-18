Two parts: a security fix that ships immediately and alone, and the feature work.

**Blocking prerequisite: decision D-5.** Step 0 must run before any code below is written. Per D-5 the user runs the dump themselves; both branches are documented so this phase is not blocked on the answer.

**What changed from v1.** Three things, all downstream of the binding decisions:

| v1 | Now | Why |
|---|---|---|
| `RoleBadges` renders the literal text **"Resident"** as the *fallback for zero roles* (v1 step 8) | `resident` is a **real badge**; zero roles is a **warning state** meaning "cannot book anything" | D-1 inverts booking to default-deny. Telling a locked-out user "Resident" would state the opposite of their actual capability. This is enumerated lockout mode 16. |
| `if (!userID) return { roles: [] }` treated as an ordinary empty-roles case | Renders an explicit **ineligible-account** state | D-7 restricts sign-in to `@u.nus.edu`; an empty canonical userID now means a pre-cutover session on an ineligible address, not "new user". |
| `roles` typed `string[]`, badge map covers `admin`/`jcrc`/`cca_head` | Same shape, plus `resident`; roles are read through the **shared** `effectiveRoles`/`getUserRoles` boundary, never re-derived here | Lockout modes 12–14: any second derivation of the role set is a place `resident` can be silently dropped. |

Everything else in v1 is carried forward unchanged and is still correct.

Cross-references: `01-data-model.md` (UserRole / UserMatric shapes), `02-backend-authz.md` (`effectiveRoles`, `getUserRoles`, `canonicalUserID`, the D-7 sign-in guard and the session `eligible` flag), `03-admin-dashboard.md` (role *mutation* lives there, never here), `05-verification.md` (test cases), `06-legacy-cutover.md` (the `role` scalar this page must not read), `07-cca-future.md` (`cca_head` badge semantics).

---

## Step 0 — Inspect the live `User` validator (BLOCKING, D-5)

The plan below wants to clear `telegramHandle` (set it null). `User` is `$jsonSchema`-guarded. `String?` in the Prisma schema means "optional/absent", **not** "null-accepting" — Prisma infers nullability from missing keys, not from the validator. And no existing write path has ever produced a null here: `src/app/api/register/route.ts` always writes concrete values after a presence check (`:44-48`), and the current `updateUserData` always writes strings (`src/server/api/routers/user.ts:48-50`). So there is a real chance the validator declares `bsonType: "string"` and the first "clear my handle" save is rejected by Mongo.

```bash
node -e "import('mongodb').then(async ({MongoClient})=>{const c=new MongoClient(process.env.DATABASE_URL);await c.connect();const info=await c.db().listCollections({name:'User'}).toArray();console.log(JSON.stringify(info[0]?.options?.validator,null,2));await c.close();})"
```

Inspect `properties.telegramHandle`, `.block`, `.bio`, `.displayName` and the `required` array. Record the answer at the top of the PR and pick a branch:

**Branch A — `bsonType` is an array including `"null"`.** Nulls are permitted. Write `telegramHandle: input.telegramHandle === "" ? null : input.telegramHandle` exactly as step 6 shows. Nothing else changes.

**Branch B — `bsonType` is the bare string `"string"` (or any form excluding null).** Do **not** write null. Use Prisma's MongoDB `unset` to remove the key instead:

```ts
telegramHandle:
  input.telegramHandle === "" ? { unset: true } : input.telegramHandle,
```

Two consequences of branch B that must be handled, not assumed away:
- The **type** of that `data` field becomes a union; `select`ing it back still yields `string | null` on read (an absent key deserialises as null), so the client code in steps 8–11 is unchanged.
- `scripts/remediation/normalize-telegram-handles.mjs` (step 3) must `$unset` rather than `$set: null`. Same decision, same branch, one place each.

**Branch C — the field appears in the validator's `required` array.** It cannot be cleared at all. Make it required in the zod schema too (`.refine((v) => v !== "")`), and drop "clear my handle" from the field matrix in step 7. Say so in the PR rather than shipping a UI affordance that always errors.

Everything below assumes **branch A**; the two places that differ are marked `// D-5 branch B`.

---

## Step 1 — SHIP ALONE: the `passwordHash` leak

`src/server/api/routers/user.ts`, `updateUserData` at **line 45**. Verified still live: the read path was hardened with an explicit `select` (`:17-26`) and the write path was not, so every "Save Changes" ships the caller's bcrypt hash into the browser, into the React Query cache, and into any client error logging.

```diff
       const updatedUser = await ctx.db.user.update({
         where: { id: userId },
         data: {
           telegramHandle: input.telegramHandle,
           bio: input.bio,
           block: input.block,
         },
+        // Mirror the read path's select. NEVER return the bare row (#9).
+        select: {
+          id: true, displayName: true, telegramHandle: true, bio: true, block: true,
+        },
       });
```

`userID` and `email` are deliberately **absent** from this select. The mutation result is merged into the cached profile in step 10, and `getCurrentUserData` overrides `userID` with the session-derived E-format value — if the mutation also returned the raw `User.userID` column, that merge would silently flip the displayed id to a stale A-format matric (invariant I-1: ~515 rows hold a matric in that column).

**Second reason this `select` is load-bearing, new since v1.** `prisma/schema.prisma:353` declares `passwordHash String` — required, non-nullable — while `PrismaAdapter` (`src/server/auth.ts:50`) creates Google-linked rows without it. A bare `update`/`findUnique` that reads all scalars throws on such a row (invariant I-2). Both procedures in this file already use an explicit `select` that omits `passwordHash`, so **this page is immune** — but only for exactly as long as nobody removes the `select`. Do not "simplify" it away. See `02-backend-authz.md` for the raw count query that establishes whether such rows exist.

Deploy this on its own. It is one line and it is a live credential leak.

---

## Step 2 — Audit legacy data (BEFORE step 4)

New validation would otherwise retro-block edits on rows that predate it. Nothing has ever enforced these: the current input is bare `z.string()`/`z.number()` (`user.ts:36-40`), and the register route only presence-checks (`register/route.ts:38-48`). The modal submits **all** fields on every save, so a user with a 4-character handle cannot change their *block*, and the error names a field they never touched.

`scripts/remediation/audit-profile-data.mjs`:

```js
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const TELEGRAM_RE = /^[A-Za-z0-9_]{5,32}$/;
const BLOCKS = [2, 3, 4, 5, 6, 7, 8];

// Explicit select: a bare findMany reads passwordHash, which is a REQUIRED
// non-nullable scalar (schema.prisma:353) that Google-adapter rows may lack —
// Prisma 6 on Mongo throws on those documents (invariant I-2).
const users = await db.user.findMany({
  select: { id: true, email: true, displayName: true, telegramHandle: true, bio: true, block: true },
});

const bad = { handle: [], bio: [], block: [], displayName: [], handleDupes: [] };
for (const u of users) {
  const h = (u.telegramHandle ?? "").replace(/^@+/, "").trim();
  if (h && !TELEGRAM_RE.test(h)) bad.handle.push({ email: u.email, value: u.telegramHandle });
  if ((u.bio ?? "").length > 500) bad.bio.push({ email: u.email, len: u.bio.length });
  if (u.block != null && !BLOCKS.includes(u.block)) bad.block.push({ email: u.email, value: u.block });
  if (!u.displayName) bad.displayName.push({ email: u.email });
}
const byHandle = new Map();
for (const u of users) {
  const h = (u.telegramHandle ?? "").replace(/^@+/, "").trim().toLowerCase();
  if (!h) continue;
  byHandle.set(h, [...(byHandle.get(h) ?? []), u.email]);
}
for (const [h, emails] of byHandle) if (emails.length > 1) bad.handleDupes.push({ handle: h, emails });

console.log(`${users.length} users`);
for (const [k, v] of Object.entries(bad)) console.log(`${k}: ${v.length}`, v.slice(0, 20));
await db.$disconnect();
```

Run it. If `handle` or `bio` violations exist, either relax the rule or run step 3's normalisation first. If `displayName` nulls exist (Google-adapter rows likely have them), **do not** use `.min(1)` on `displayName`.

---

## Step 3 — Normalise telegram handles

`scripts/remediation/normalize-telegram-handles.mjs`: trim, strip leading `@`(s), coerce `""` to null — or `$unset`, per the step 0 branch. Dry-run by default, `APPLY=yes` to write, matching the convention of every other script in that directory.

Store handles **without** the leading `@` and render `@{handle}`, so there is one canonical form. This changes how existing rows display, so the script and the UI change ship together.

The register route must be normalised too, or new signups immediately re-introduce the mixed forms — see step 5.

**Uniqueness is dropped from v1.** Two reasons: a `findFirst` check is TOCTOU-racy anyway, and the CONFLICT message is an existence oracle letting any authenticated user enumerate which Telegram handles belong to residents — which partly undoes the deliberate restriction in `facilitiesBooking.ts` that keeps handles private to their owner. If you want it later, it needs a partial case-insensitive unique index (legal on a validator-guarded collection — validators constrain document *shape*, indexes constrain *uniqueness across documents*; the same reasoning `07-cca-future.md` uses for `UserCCA`) after this script reports zero duplicates.

---

## Step 4 — Shared schema: `src/lib/schemas/profile.ts` (new)

Not under `src/server/`. The client needs the **runtime value** to mirror validation, and a `"use client"` component value-importing from `src/server/` risks pulling Prisma into the browser bundle and breaks if a `server-only` guard is ever added. `src/lib/` already holds `password.ts`, `rateLimit.ts`, `email.ts`, `utils.ts` — this follows that convention.

```ts
import { z } from "zod";

export const BLOCKS = [2, 3, 4, 5, 6, 7, 8] as const;
export const TELEGRAM_RE = /^[A-Za-z0-9_]{5,32}$/;   // Telegram's own rule

/** Strip control characters and zero-width / bidi-override codepoints.
 *  displayName is rendered to OTHER users on every booking listing, so an
 *  unfiltered value allows impersonation via homoglyphs, invisible padding, or
 *  a right-to-left override. React escaping prevents XSS, not impersonation. */
const sanitizeName = (s: string) =>
  s.replace(/[ -​-‏‪-‮﻿]/g, "")
   .replace(/\s+/g, " ")
   .trim();

export const updateProfileInput = z.object({
  // NOT .min(1): pre-existing rows (Google adapter) may have no displayName,
  // and requiring it would block those users from editing anything else.
  displayName: z.string().max(60).transform(sanitizeName),
  bio: z.string().trim().max(500, "Bio must be 500 characters or fewer"),
  telegramHandle: z.string().trim()
    .transform((v) => v.replace(/^@+/, ""))
    .refine((v) => v === "" || TELEGRAM_RE.test(v), {
      message: "Telegram handle must be 5–32 characters: letters, digits or _",
    }),
  block: z.number().int().refine(
    (n) => (BLOCKS as readonly number[]).includes(n), "Invalid block"),
});

export type UpdateProfileInput = z.input<typeof updateProfileInput>;
```

`block` stays **required**, matching signup, which mandates it. Fix the fabricated default — `src/app/profile/page.tsx:55` currently passes `block: user?.block ?? 8`, so a user who never set a block sees Block 8 pre-selected and can save it by accident — by initialising the select to unset, not by making null a savable state.

**This schema must never gain a `roles`, `userID`, `email` or `matric` key.** See the comment in step 6.

---

## Step 5 — Close the parallel write path

`src/app/api/register/route.ts` writes `telegramHandle`, `displayName`, `bio` raw and `block: Number(blockNumber)` with no enum or NaN check — every constraint added above is bypassable by signing up instead of editing, and the "one canonical form" premise fails on day one.

Parse the payload with the same field schemas from `src/lib/schemas/profile.ts` before `db.user.create`. The route currently has no zod validation at all, so this fixes both surfaces.

Two adjacent lines in that route belong to other phases; **do not** change them here, just be aware they are moving:
- `:51` the `@u.nus.edu` domain check — replaced by the shared D-7 predicate (`02-backend-authz.md`).
- `:~64` `userID: email.toUpperCase().replace("@U.NUS.EDU","")` — replaced by the anchored `canonicalUserID` (`02-backend-authz.md`). It is not the role key regardless (invariant I-1).

---

## Step 6 — Rewrite the procedures

`src/server/api/routers/user.ts`. Both procedures, in full.

```ts
import { updateProfileInput } from "~/lib/schemas/profile";
import { getUserRoles } from "../services/access";

getCurrentUserData: protectedProcedure.query(async ({ ctx }) => {
  const userId = ctx.session.user.id;
  const userID = ctx.session.user.userID;   // canonical E-format key (I-1)

  const user = await ctx.db.user.findUnique({
    where: { id: userId },
    select: {                                // never ship passwordHash (#9, I-2)
      id: true, userID: true, email: true, displayName: true,
      telegramHandle: true, bio: true, block: true, createdAt: true,
    },
  });
  if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

  // D-7: session.user.userID is derived from the email and is EMPTY for an
  // account that is not on @u.nus.edu. Before D-7 that was an odd edge case;
  // now it means a pre-cutover JWT on an ineligible address. Do not key lookups
  // on it, do not override a real stored id with "", and do not silently render
  // this as an ordinary zero-roles profile — step 11 gives it its own state.
  if (!userID) {
    return { ...user, matric: null, hasMatric: false, roles: [] as string[], eligible: false };
  }

  const [matricRow, roles] = await Promise.all([
    ctx.db.userMatric.findUnique({ where: { userID } }),
    // THE shared read boundary (02-backend-authz.md). getUserRoles resolves
    // through effectiveRoles, which DERIVES `resident` from the canonical id
    // rather than trusting the stored array. Never re-derive roles here: a
    // second derivation is exactly where `resident` gets silently dropped
    // (lockout modes 12-14).
    getUserRoles(ctx.db, userID),
  ]);

  return {
    ...user,
    userID,                                  // session value, not the stale column
    matric: matricRow?.matric ?? null,
    hasMatric: Boolean(matricRow?.matric),
    roles,                                   // string[] — DISPLAY ONLY (I-5)
    eligible: true,
  };
}),

updateUserData: protectedProcedure
  .input(updateProfileInput)
  .mutation(async ({ ctx, input }) => {
    // SECURITY: never add userID / email / role / roles / matric to this input
    // schema. The target is always ctx.session.user.id, never client-supplied,
    // so there is no IDOR here — and zod strips unknown keys, so the only way a
    // user escalates through this procedure is if someone ADDS such a key.
    // Role mutation lives in 03-admin-dashboard.md behind the G1..G7 guards.
    const updated = await ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: {
        displayName: input.displayName,
        bio: input.bio,
        // D-5 branch B: use `{ unset: true }` instead of `null` here.
        telegramHandle: input.telegramHandle === "" ? null : input.telegramHandle,
        block: input.block,
      },
      select: { id: true, displayName: true, telegramHandle: true, bio: true, block: true },
    });
    return updated;
  }),
```

Three rules this file must keep obeying:

1. **`getUserRoles` only.** Do not read `UserRole` directly and do not read the legacy `role` scalar. `06-legacy-cutover.md` enumerates every legacy read that must be deleted; if this page adds a new one, it becomes an item on that list and a way for a phase-2 revert to disagree with itself.
2. **No new `User` fields.** The collection is `$jsonSchema`-validated, so any new column is rejected by Mongo at write time. Every field above already exists on the model. A genuinely new profile attribute goes in a separate collection, following the `UserMatric` / `UserRole` pattern (`01-data-model.md`).
3. **The `select` clauses stay.** Step 1 explains both reasons.

If `02-backend-authz.md` has not landed yet, `getUserRoles` does not exist. Shim it inline — typed `string[]` from day one, and **including the resident derivation**, or the badges will lie during the gap:

```ts
// TEMPORARY shim. Delete when 02 lands; do not let this derivation diverge.
const r = await ctx.db.userRole.findUnique({ where: { userID } });
const stored = r?.roles?.length ? r.roles : r?.role ? [r.role] : [];
const roles: string[] = stored.includes("resident") || !userID.includes("@")
  ? Array.from(new Set([...stored, "resident"]))
  : stored;
```

---

## Step 7 — Field matrix

| Field | View | Edit | Why |
|---|---|---|---|
| `displayName` | yes (heading) | **yes** (new) | Already on the model. Fixes the dead `name` prop (`EditProfileModal.tsx:11`, accepted and never read). |
| `bio` | yes | yes | existing |
| `telegramHandle` | yes | yes | normalised, `@` stripped |
| `block` | yes | yes (2–8) | now server-validated |
| `email` | yes | **no** | It is the login identity and the derivation source for `session.user.userID`. Changing it silently re-keys the user's roles, matric and bookings — and under D-7 it is also the eligibility input. Hard no. |
| `userID` (E-format) | yes, read-only mono | no | canonical key. Display the **session-derived** value, never `User.userID`. |
| `matric` | yes, masked `A•••••••X` + reveal toggle | **no** in v1 | Identity credential set once at onboarding. "Wrong matric? Contact JCRC." |
| `roles` | yes, read-only badges | **no** | Mutation is admin/JCRC only — `03-admin-dashboard.md`. There is deliberately no self-service role control anywhere on this page, including no CCA-head handover (`07-cca-future.md` defers self-serve succession). |
| `createdAt` | yes ("Member since") | no | already selected, currently unused |

---

## Step 8 — `RoleBadges` component

`src/app/_components/RoleBadges.tsx`. **This is the component D-1 changed.**

```tsx
/**
 * DISPLAY ONLY. Never the basis of a permission decision (invariant I-7):
 * every capability these badges imply is independently enforced server-side.
 *
 * D-1: `resident` is a REAL role and the baseline booking capability — it is
 * badged. The zero-roles case is therefore NOT "Resident"; it means the user
 * currently cannot book anything, and saying otherwise would tell a locked-out
 * user they are fine (enumerated lockout mode 16).
 */
const ROLE_META: Record<string, { label: string; className: string; title: string }> = {
  admin:    { label: "Admin",    className: "bg-red-100 text-red-800 border-red-300",
              title: "Full access, including role management." },
  jcrc:     { label: "JCRC",     className: "bg-emerald-100 text-emerald-800 border-emerald-300",
              title: "Can manage roles and book the SCRC Room." },
  cca_head: { label: "CCA Head", className: "bg-indigo-100 text-indigo-800 border-indigo-300",
              title: "Can book CCA rooms." },
  resident: { label: "Resident", className: "bg-slate-100 text-slate-700 border-slate-300",
              title: "Verified NUS resident. Can book normal rooms." },
};

/** Baseline first, then escalating. Stable order so the row does not reshuffle
 *  between renders when the underlying array order changes. */
const ORDER = ["resident", "cca_head", "jcrc", "admin"];

export function RoleBadges({ roles }: { roles: string[] }) {
  // "user" was the v1 implicit default and is never stored. If it appears at
  // all, it is legacy data; do not badge it.
  const shown = roles.filter((r) => r !== "user");

  if (shown.length === 0) {
    return (
      <span
        className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800"
        title="You do not currently hold any role, so you cannot book facilities. If you just signed up, reload the page. If this persists, contact the JCRC."
      >
        No roles — cannot book
      </span>
    );
  }

  const sorted = [...shown].sort(
    (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99),
  );

  return (
    <div className="flex flex-wrap gap-2">
      {sorted.map((r) => {
        const m = ROLE_META[r] ?? {
          label: r, className: "bg-gray-100 text-gray-800 border-gray-300", title: "",
        };
        return (
          <span key={r} title={m.title}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${m.className}`}>
            {m.label}
          </span>
        );
      })}
    </div>
  );
}
```

Notes:

- The unknown-role fallback is retained deliberately. `UserRole.roles` is a `String[]` in a collection with no `$jsonSchema` validator, so an out-of-vocabulary string is physically possible; rendering it neutrally makes it visible instead of invisible. It confers nothing — `effectiveRoles` drops unknown strings before any authorization check.
- If `02-backend-authz.md` ships an affirmative sanction role (the `suspended` proposal), add one `ROLE_META` entry for it in destructive styling. Do **not** invent it here; the badge follows the vocabulary, it does not define it.
- The "No roles" copy is the user-facing half of lockout detection. Its machine-facing half is the doctor query in `05-verification.md`.

---

## Step 9 — Modal fixes (`src/app/_components/EditProfileModal.tsx`)

The existing bugs, each confirmed by reading the file:

1. **Stale state on cancel-then-reopen.** The modal is mounted unconditionally once loading finishes (`profile/page.tsx:47-59`) and only `return null`s internally (`EditProfileModal.tsx:52`), so its `useState` initialisers (`:25-29`) run once, on first mount. Open → type a new bio → Close → reopen shows the abandoned edits presented as the current profile. Fix: mount only when open, or `key={String(openEditProfileModal)}`.
2. **Silent mutation failure.** Only `onSuccess` is supplied (`:32-37`). A rejection leaves the modal sitting there with no feedback. Add `onError` → inline red banner. This is why step 1 ships separately: without `onError`, a validation change would fail app-wide invisibly.
3. **No pending state.** `handleSubmit` (`:39-50`) is not guarded by `isPending` and Save is never disabled — rapid clicks fire N concurrent updates.
4. **Dead `displayName`.** The page passes `name` into the modal (`page.tsx:52`); the modal accepts it in its props type (`:11`) and never reads or sends it. Now genuinely editable.
5. **Error copy.** Replace `"Don't anyhow leh"` (`:104`) with an actionable message.
6. **Both footer buttons are identical emerald** (`:110-121`). Close should be neutral/outline.
7. **Accessibility.** No `role="dialog"`, no `aria-modal`, no focus trap, no Escape handler, and the close `×` is `absolute` (`:59`) inside a non-`relative` parent so it may position against the viewport. `~/components/ui/dialog` exists (`src/components/ui/dialog.tsx`) and gives all of this for free — adopt it while in here.

Additions: `displayName` input (`maxLength={60}`), `bio` textarea with `maxLength={500}` and a live `{n}/500` counter, `@` as a static prefix inside the telegram field with any typed `@` stripped on change, and client-side `updateProfileInput.safeParse` mirroring the server.

**The modal renders no role control of any kind.** Roles appear on the page (step 11) as badges only. There is no checkbox, no select, and no `roles` key in the mutation payload — which is what makes it structurally impossible for a profile save to strip `resident` (enumerated lockout mode 16). Keep it that way.

---

## Step 10 — Cache strategy

**No optimistic updates.** The server normalises (`trim`, `@`-strip, `sanitizeName`), so an optimistic value is frequently wrong and flickers on reconcile. Profile edits are rare and not latency-sensitive.

Instead: mutate → merge the returned row into the cache → close.

```ts
const utils = api.useUtils();
const updateUser = api.user.updateUserData.useMutation({
  onSuccess: (updated) => {
    // The merge matters: the mutation deliberately returns neither roles nor
    // matric nor eligible, so a naive setData(updated) would blank the badges
    // until the background invalidate resolves — i.e. it would flash the
    // "No roles — cannot book" warning at a user who is perfectly fine.
    utils.user.getCurrentUserData.setData(undefined, (old) => (old ? { ...old, ...updated } : old));
    void utils.user.getCurrentUserData.invalidate();
    onSuccess();
    onClose();
  },
  onError: (e) => setFormError(e.message),
});
```

Because the mutation's `select` omits `userID` and `email` (step 1), this merge cannot clobber the session-derived id.

---

## Step 11 — Page changes (`src/app/profile/page.tsx`)

- **Ineligible-account branch first**, before the normal render. When `user.eligible === false` (D-7), render an explanatory panel — "This account is not an NUS student account, so it cannot be used to book facilities" — with a sign-out button, and skip the badges and the Edit button entirely. Rendering the ordinary profile with an amber "No roles" pill would misdiagnose a policy state as a data problem. Coordinate the exact copy and any route-level redirect with the D-7 section of `02-backend-authz.md`; this page must not be the only place that state is reachable.
- Heading: `user?.displayName ?? session?.user.name` (currently `session?.user.name` alone, `:81`). Query first — combined with the `session.user.name` refresh added in `02-backend-authz.md`, an edited name updates everywhere rather than only here.
- `<RoleBadges roles={user?.roles ?? []} />` beneath the userID line (`:83-85`). Source the array from **the query**, not from `session.user.roles`: the session copy is explicitly render-only (I-5) and is the value the admin dashboard also reads, so keeping the profile on the procedure's array means one fetch, one derivation, one place to audit.
- Do **not** render badges while `isLoading` — an empty array during load is indistinguishable from genuinely zero roles and would flash the lockout warning on every page view. Render a skeleton or nothing.
- About Me (`:106`): `{user?.bio || <span className="italic text-gray-400">No bio yet — tell people about yourself.</span>}`
- Telegram (`:131`): `{user?.telegramHandle ? \`@${user.telegramHandle}\` : "Not set"}`. Email row (`:120-122`) gains a "Cannot be changed" hint.
- Sidebar (`:139-156`): Block (`{user?.block ?? "Not set"}`), Matric (masked `A•••••••X` with an eye toggle), Member since (`createdAt` via `date-fns`).
- Modal mounting: fix the stale-state bug; change `block: user?.block ?? 8` (`:55`) to leave it unset.
- Add an `isError` branch — a failed `getCurrentUserData` currently renders an empty shell forever.

---

## Ordered summary

0. Inspect the `User` validator (D-5). **Blocking.** Record the branch in the PR.
1. `passwordHash` `select` fix. **Ship alone.**
2. `audit-profile-data.mjs` — see what legacy data violates the new rules.
3. `normalize-telegram-handles.mjs`.
4. `src/lib/schemas/profile.ts`.
5. Normalise `register/route.ts`.
6. Rewrite both procedures (`getUserRoles` + `eligible`).
7. `RoleBadges.tsx`.
8. Modal rewrite.
9. Page rewrite.

**Steps 6 and 8 must ship together.** The new input requires `displayName`, which the deployed modal does not send — and with no `onError` handler, every profile save would fail silently app-wide. Only step 1 is genuinely independently deployable.

**This phase depends on `02-backend-authz.md` for `getUserRoles` and the session `eligible` flag, and must ship after it.** If it ships first, use the step 6 shim and delete it in the same PR that lands 02 — but note the shim's resident derivation must match `effectiveRoles` exactly or the badges will disagree with the booking path.

---

## Done when

**Step 0 / D-5**
- [ ] Validator inspected; branch A / B / C recorded at the top of the PR.
- [ ] If branch B: both `updateUserData` and `normalize-telegram-handles.mjs` use `unset`, not `null`.

**Security**
- [ ] Network response of a successful save contains **no** `passwordHash`.
- [ ] `grep -n "select" src/server/api/routers/user.ts` shows an explicit select on **both** the `findUnique` and the `update`.
- [ ] `{ ...valid, roles: ["admin"], userID: "E0000001", email: "x@y.z" }` → extra keys stripped, no row mutated beyond the four allowed fields, caller's roles unchanged in `UserRole`.
- [ ] No role-bearing key exists anywhere in `updateProfileInput`.

**Validation**
- [ ] A 10 000-character bio via a direct tRPC call returns BAD_REQUEST.
- [ ] `block: 99`, `block: 3.5`, `block: -1` all rejected.
- [ ] Handle entered as `@alice`, ` alice `, `Alice` all store one canonical form.
- [ ] `displayName` with zero-width or bidi characters is stripped.
- [ ] The same handle rejected by the modal is also rejected by `POST /api/register`.

**Roles (D-1)**
- [ ] A plain verified NUS user with no `UserRole` row renders a **Resident** badge — proving the derivation reaches this page, not just the booking path.
- [ ] Roles `["resident","jcrc"]` → two badges, Resident first.
- [ ] Roles `["resident","cca_head","admin"]` → three badges in Resident / CCA Head / Admin order.
- [ ] Zero roles → the amber **"No roles — cannot book"** pill, **not** the word "Resident".
- [ ] Unknown role `"foo"` → neutral `foo` badge, and that user's booking capability is unchanged.
- [ ] Badges do not flash during `isLoading`.
- [ ] Saving a profile edit does **not** change the caller's `UserRole.roles` array (check before/after in Atlas).
- [ ] After a save, badges are still rendered during the cache merge — no flicker to the amber pill.

**D-7**
- [ ] An account whose canonical userID is empty renders the ineligible-account panel with a working sign-out, not an empty-roles profile.

**Regressions / UX**
- [ ] Editing displayName updates the heading **and** the header/booking listings after one navigation.
- [ ] Open modal → edit → Close → reopen shows **saved** values, not abandoned edits.
- [ ] Forced mutation error shows an inline message, modal stays open, Save re-enabled.
- [ ] Save is disabled while `isPending`; double-clicking fires one mutation.
- [ ] Brand-new user (null bio/telegram/block) renders placeholders and does not crash.
- [ ] A legacy user with a 4-character handle can still save a block change (or the audit confirmed none exist).
- [ ] A failed `getCurrentUserData` renders an error state, not an empty shell.
- [ ] Modal is reachable and dismissible by keyboard alone (Tab, Escape).
